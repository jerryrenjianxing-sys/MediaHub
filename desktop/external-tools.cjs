'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const PS = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
function powershellJson(script, input) {
  const encodedInput = Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
  const source = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);$inputRecord=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedInput}'))|ConvertFrom-Json;${script}`;
  const encoded = Buffer.from(source, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', data => { output += data; if (output.length > 1024 * 1024) child.kill(); }); child.stderr.on('data', data => { error += data; });
    const timer = setTimeout(() => child.kill(), 20000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`安装身份检查失败：${error.slice(0, 600)}`)); else { try { resolve(JSON.parse(output.replace(/^\uFEFF/, '').trim() || 'null')); } catch { reject(new Error('安装身份检查没有返回有效结果')); } } });
  });
}
async function verifyExternal(tool, executable) {
  if (!path.isAbsolute(executable) || !fs.existsSync(executable) || path.extname(executable).toLowerCase() !== '.exe') throw new Error('请选择实际安装的工具可执行文件');
  const info = await powershellJson("$v=(Get-Item -LiteralPath $inputRecord.path).VersionInfo;@{productName=$v.ProductName;version=$v.ProductVersion;fileVersion=$v.FileVersion;originalFilename=$v.OriginalFilename}|ConvertTo-Json -Compress", { path: executable });
  const products = tool.detection?.productNames || [tool.name];
  if (!products.some(name => name.toLowerCase() === String(info.productName).toLowerCase())) throw new Error(`此文件身份为 ${info.productName || '未知'}，与 ${tool.name} 不符`);
  const expectedExecutables = (tool.detection?.processNames || []).map(name => name.toLowerCase().replace(/\.exe$/, '') + '.exe');
  if (!expectedExecutables.includes(path.basename(executable).toLowerCase())) throw new Error('工具可执行文件名与已知发行身份不符');
  const candidates = [info.fileVersion, info.version].filter(Boolean).map(String);
  const version = (candidates.find(value => /\d+\.\d+\.\d+-/.test(value)) || candidates[0] || '').match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
  if (!version) throw new Error('无法回读实际安装版本');
  return { id: tool.id, installPath: executable, version, productName: info.productName, ...originalReferences(tool, executable) };
}
function originalReferences(tool, executable) {
  let dataPaths = (tool.detection?.dataPaths || []).map(value => value.replace(/%([^%]+)%/g, (_m, name) => process.env[name] || _m));
  const services = [];
  const local = process.env.LOCALAPPDATA;
  const read = file => { try { if (fs.statSync(file).size > 1024 * 1024) return null; return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
  const addEndpoint = (type, value, file, pid) => {
    try { const parsed = new URL(value); if (!['http:', 'ws:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) return; services.push({ type, endpoint: parsed.origin, discoveryFile: file, pid: Number.isSafeInteger(pid) ? pid : null, state: 'reference' }); } catch {}
  };
  if (tool.id === 'mediaflow') {
    const marker = path.join(path.dirname(executable), 'resources/instance-profile.path');
    try {
      const file = fs.readFileSync(marker, 'utf8').replace(/^\uFEFF/, '').trim();
      if (path.isAbsolute(file)) {
        const value = read(file);
        if (value?.schema === 1 && path.isAbsolute(value.data_root || '')) {
          dataPaths = [path.resolve(value.data_root)];
          if (typeof value.task_name === 'string') services.push({ type: 'windows-task', name: value.task_name, discoveryFile: file, state: 'reference' });
          for (const [name, port] of [['api', value.api_port], ['ui', value.ui_port]]) if (Number.isInteger(port) && port > 0 && port < 65536) addEndpoint(name, `http://127.0.0.1:${port}`, file);
        }
      }
    } catch {}
  } else if (tool.id === 'media-deep-researcher') {
    const file = process.env.MEDIAWORKBENCH_INSTANCE || path.join(local, 'MediaWorkbench/instance.json');
    const value = read(file);
    if (value?.product === 'Media Deep Researcher' || value?.product === 'MediaWorkbench') {
      if (path.isAbsolute(value.data_directory || '')) dataPaths = [value.data_directory];
      addEndpoint('api', value.base_url, file, value.pid);
    } else dataPaths = [process.env.MEDIAWORKBENCH_DATA_DIR && path.isAbsolute(process.env.MEDIAWORKBENCH_DATA_DIR) ? process.env.MEDIAWORKBENCH_DATA_DIR : path.join(local, 'MediaWorkbench/data')];
  } else if (tool.id === 'mediasail') {
    const dir = process.env.EASEL_DESKTOP_DATA || path.join(local, 'ElectronEasel');
    const file = path.join(dir, 'agent-connection.json'); const value = read(file);
    dataPaths = [dir]; if (value?.product === 'MediaSail') { if (path.isAbsolute(value.workspace || '')) dataPaths.push(value.workspace); addEndpoint('api', value.baseUrl, file, value.pid); }
  }
  return { dataPaths: [...new Set(dataPaths)], services };
}
async function scanExternal(tool, { candidatesOnly = false } = {}) {
  const candidates = (tool.detection?.executables || []).map(value => (typeof value === 'string' ? value : value.path).replace(/%([^%]+)%/g, (_m, name) => process.env[name] || _m));
  if (!candidatesOnly) {
    const registry = await powershellJson("$items=@();foreach($root in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')){if(Test-Path -LiteralPath $root){foreach($key in Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue){$v=Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue;if($inputRecord.names -contains $v.DisplayName){$items+=@{name=$v.DisplayName;location=$v.InstallLocation;icon=$v.DisplayIcon}}}}};ConvertTo-Json -InputObject @($items) -Compress", { names: tool.detection?.productNames || [tool.name] });
    for (const record of registry || []) {
      if (record.icon) { const icon = record.icon.replace(/,\s*-?\d+$/, '').replace(/^"|"$/g, ''); if (path.isAbsolute(icon)) candidates.push(icon); }
      if (record.location) for (const name of tool.detection?.processNames || []) candidates.push(path.join(record.location, name.replace(/\.exe$/i, '') + '.exe'), path.join(record.location, 'current', name.replace(/\.exe$/i, '') + '.exe'));
    }
  }
  for (const candidate of [...new Set(candidates)]) {
    if (!fs.existsSync(candidate)) continue;
    try { return await verifyExternal(tool, candidate); } catch { /* Ignore unrelated or incomplete installations. */ }
  }
  return null;
}
module.exports = { verifyExternal, scanExternal, powershellJson, originalReferences };
