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
  const version = String(info.version || info.fileVersion || '').match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
  if (!version) throw new Error('无法回读实际安装版本');
  return { id: tool.id, installPath: executable, version, productName: info.productName, dataPaths: (tool.detection?.dataPaths || []).map(value => value.replace(/%([^%]+)%/g, (_m, name) => process.env[name] || _m)) };
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
module.exports = { verifyExternal, scanExternal, powershellJson };
