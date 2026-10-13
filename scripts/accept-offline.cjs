'use strict';
// Deliberately refuses local/self-hosted execution. Only this disposable CI VM's
// component executables receive temporary rules; no firewall policy is changed.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const net = require('node:net');
const assert = require('node:assert/strict');
const readline = require('node:readline');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const exec = promisify(execFile);
const repo = path.resolve(__dirname, '..');
const root = path.join(repo, 'work', 'offline-acceptance');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const { atomicJson, within, sha256 } = require('../desktop/core/files.cjs');
function redact(value) {
  return String(value).replaceAll(root, '[acceptance-root]')
    .replace(/([?&](?:token|access_token|refresh_token|key)=)[^\s&#"']+/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, '[REDACTED]');
}
function scrub(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
  return value;
}
function writeBoundedRaw(file, value, maxBytes = 2 * 1024 * 1024) {
  const safe = scrub(value); const serialized = JSON.stringify(safe);
  if (Buffer.byteLength(serialized) <= maxBytes) atomicJson(file, safe);
  else atomicJson(file, { truncated: true, originalBytes: Buffer.byteLength(serialized), tail: serialized.slice(-Math.floor(maxBytes / 4)) });
}
const runtimeName = /^(node|chrome-headless-shell|ffmpeg|ffprobe)\.exe$/i;
// A missing CIM path is immediately rechecked in the same sample. DateTime ticks
// are compared at CIM's microsecond precision, without changing token privileges.
function processSnapshotScript() {
  return `$rows = @(foreach ($cim in @(Get-CimInstance Win32_Process)) {
    $created = if ($null -ne $cim.CreationDate) {$cim.CreationDate.ToUniversalTime()} else {$null};
    $row = [ordered]@{ProcessId=$cim.ProcessId;ParentProcessId=$cim.ParentProcessId;Name=$cim.Name;ExecutablePath=$cim.ExecutablePath;CreationDate=if($created){$created.ToString('o')}else{$null};PathState='cim';RecheckCreationDate=$null;AliveAtRecheck=$null;RecheckError=$null};
    if ($cim.Name -match '^(node|chrome-headless-shell|ffmpeg|ffprobe)\\.exe$' -and [string]::IsNullOrWhiteSpace($row.ExecutablePath)) {
      $live = Get-Process -Id $cim.ProcessId -ErrorAction SilentlyContinue;
      if ($null -eq $live) {$row.PathState='unknownExited';$row.AliveAtRecheck=$false;$row.RecheckError='pid-no-longer-present'}
      else {try {
        $start = $live.StartTime.ToUniversalTime(); $row.RecheckCreationDate=$start.ToString('o');
        if ($null -eq $created) {$row.PathState='unknownAlive';$row.AliveAtRecheck=$true;$row.RecheckError='cim-creation-time-unavailable'}
        elseif ([Math]::Abs($start.Ticks-$created.Ticks) -ge 10) {$row.PathState='unknownExited';$row.AliveAtRecheck=$false;$row.RecheckError='pid-instance-changed'}
        elseif ($live.HasExited) {$row.PathState='unknownExited';$row.AliveAtRecheck=$false;$row.RecheckError='same-instance-exited'}
        else {$candidate=$live.Path; if(-not [string]::IsNullOrWhiteSpace($candidate)) {$row.ExecutablePath=$candidate;$row.PathState='get-process';$row.AliveAtRecheck=$true}
          elseif($live.HasExited) {$row.PathState='unknownExited';$row.AliveAtRecheck=$false;$row.RecheckError='exited-during-path-read'}
          else {$row.PathState='unknownAlive';$row.AliveAtRecheck=$true;$row.RecheckError='live-path-unavailable'} }
      } catch {
        $again = Get-Process -Id $cim.ProcessId -ErrorAction SilentlyContinue;
        if($null -eq $again) {$row.PathState='unknownExited';$row.AliveAtRecheck=$false;$row.RecheckError='exited-during-recheck'}
        else {$row.PathState='unknownAlive';$row.AliveAtRecheck=$true;$row.RecheckError=$_.FullyQualifiedErrorId}
      }}
    }; [PSCustomObject]$row
  }); $rows | ConvertTo-Json -Depth 5 -Compress`;
}
function mergeObservation(seen, row) {
  const key = `${row.ProcessId}|${row.CreationDate || '<creation-unavailable>'}`;
  const previous = seen.get(key);
  // Only this same PID+creation instance may reuse an earlier observed path.
  if (!row.ExecutablePath && previous?.ExecutablePath) seen.set(key, { ...row, ExecutablePath: previous.ExecutablePath, LastObservationState: row.PathState, PathState: 'same-instance-history', PathObservedAt: previous.PathObservedAt });
  else seen.set(key, { ...row, PathObservedAt: row.ExecutablePath ? new Date().toISOString() : null });
}
function classifyObservations(rows, component) {
  const summary = { verified: 0, unknownExited: 0, unknownAlive: 0, outside: 0, verifiedRuntimeNames: [] };
  const verifiedNames = new Set(); const observed = rows.map(row => {
    if (!runtimeName.test(row.Name)) return { name: row.Name, creationDate: row.CreationDate, state: 'support-process', packaged: row.ExecutablePath ? within(component, row.ExecutablePath) : null };
    let state;
    if (row.ExecutablePath) { state = !within(component, row.ExecutablePath) ? 'outside' : row.CreationDate ? 'verified' : 'unknownAlive'; }
    else state = row.PathState === 'unknownExited' ? 'unknownExited' : 'unknownAlive';
    summary[state]++; if (state === 'verified') verifiedNames.add(row.Name.toLowerCase());
    return { name: row.Name, creationDate: row.CreationDate, state, packaged: state === 'verified' ? true : state === 'outside' ? false : null, pathSource: row.PathState };
  }); summary.verifiedRuntimeNames = [...verifiedNames].sort(); return { summary, observed };
}

function assertHostedRunner(env = process.env, platform = process.platform) {
  if (platform !== 'win32' || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.RUNNER_OS !== 'Windows' || !/^\d+$/.test(env.GITHUB_RUN_ID || '') || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT || '') || !env.RUNNER_TEMP) {
    throw new Error('Offline acceptance is restricted to a disposable GitHub-hosted Windows runner. Personal and self-hosted machines are refused.');
  }
}
function acceptedPackage(url, digest) {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/jerryrenjianxing-sys\/MediaHub\/releases\/download\/hyperframes-v(\d+\.\d+\.\d+-preview\.\d+)\/MediaHub-HyperFrames-\1-win-x64\.zip$/);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password || parsed.search || parsed.hash || !match || !/^[a-f0-9]{64}$/i.test(digest || '')) throw new Error('Supply an immutable MediaHub HyperFrames GitHub release ZIP URL and its full SHA256.');
  return { url: parsed.href, sha256: digest.toLowerCase(), version: match[1] };
}
function ruleGroup(env = process.env) { return `MediaHub Offline Acceptance ${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`; }
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;
async function powershell(script, timeout = 45000) {
  const executable = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const prefix = "$ErrorActionPreference = 'Stop'; [Console]::InputEncoding = [Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ";
  const { stdout } = await exec(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(prefix + script, 'utf16le').toString('base64')], { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim() ? JSON.parse(stdout) : null;
}
async function firewallState() {
  return powershell("[PSCustomObject]@{service=(Get-Service -Name MpsSvc).Status.ToString();profiles=@(Get-NetFirewallProfile | Sort-Object Name | Select-Object Name,Enabled,DefaultInboundAction,DefaultOutboundAction)} | ConvertTo-Json -Depth 5 -Compress");
}
async function removeRules() {
  assertHostedRunner();
  const group = psQuote(ruleGroup());
  return powershell(`$rules = @(Get-NetFirewallRule -Group ${group} -ErrorAction SilentlyContinue); $count = $rules.Count; $rules | Remove-NetFirewallRule; [PSCustomObject]@{removed=$count;remaining=@(Get-NetFirewallRule -Group ${group} -ErrorAction SilentlyContinue).Count} | ConvertTo-Json -Compress`);
}
async function installRules(component) {
  const group = ruleGroup();
  const programs = ['runtime/node/node.exe', 'runtime/chrome/chrome-headless-shell.exe', 'runtime/ffmpeg/ffmpeg.exe', 'runtime/ffmpeg/ffprobe.exe'];
  // These exact ranges exclude the entire IPv4 loopback network and IPv6 ::1.
  const remote = ['0.0.0.0-126.255.255.255', '128.0.0.0-255.255.255.255', '::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'];
  const existing = await powershell(`@(Get-NetFirewallRule -Group ${psQuote(group)} -ErrorAction SilentlyContinue).Count | ConvertTo-Json -Compress`);
  assert.equal(existing, 0, 'This run must not replace any preexisting firewall rules');
  for (let i = 0; i < programs.length; i++) {
    const program = fs.realpathSync(path.join(component, programs[i]));
    assert.ok(within(component, program), 'Firewall programs must be inside the verified component');
    await powershell(`New-NetFirewallRule -Name ${psQuote(`MediaHubOffline-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${i}`)} -DisplayName ${psQuote(`${group} ${path.basename(program)}`)} -Group ${psQuote(group)} -Direction Outbound -Action Block -Enabled True -Profile Any -Program ${psQuote(program)} -RemoteAddress @(${remote.map(psQuote).join(',')}) | Out-Null; $true | ConvertTo-Json -Compress`);
  }
  const rules = await powershell(`@(Get-NetFirewallRule -Group ${psQuote(group)} | ForEach-Object {[PSCustomObject]@{name=$_.Name;enabled=$_.Enabled.ToString();direction=$_.Direction.ToString();action=$_.Action.ToString();program=($_ | Get-NetFirewallApplicationFilter).Program;remoteAddress=@(($_ | Get-NetFirewallAddressFilter).RemoteAddress)}}) | ConvertTo-Json -Depth 5 -Compress`);
  assert.equal(rules.length, programs.length);
  for (const rule of rules) { assert.equal(rule.action, 'Block'); assert.equal(rule.direction, 'Outbound'); assert.equal(rule.enabled, 'True'); assert.ok(typeof rule.program === 'string' && within(component, rule.program), `Firewall program failed package boundary check: ${redact(String(rule.program)).slice(0, 200)}`); }
  return rules;
}
async function download(pkg, target) {
  const response = await fetch(pkg.url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`Component download failed with HTTP ${response.status}`);
  let bytes = 0;
  const limiter = new (require('node:stream').Transform)({ transform(chunk, _encoding, done) { bytes += chunk.length; done(bytes > 2 * 1024 ** 3 ? new Error('Component archive exceeded 2 GiB acceptance limit') : null, chunk); } });
  await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(target, { flags: 'wx' }));
  assert.equal(await sha256(target), pkg.sha256, 'Downloaded component SHA256 mismatch');
  return bytes;
}
async function verifyManifest(component, expectedVersion) {
  const manifest = JSON.parse(await fsp.readFile(path.join(component, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, 'hyperframes'); assert.equal(manifest.version, expectedVersion); assert.equal(manifest.upstreamVersion, '0.8.151'); assert.equal(manifest.platform, 'win32'); assert.equal(manifest.arch, 'x64'); assert.equal(manifest.entry, 'service-entry.mjs');
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 100);
  const seen = new Set();
  for (const item of manifest.files) {
    assert.equal(typeof item.path, 'string'); assert.ok(!path.isAbsolute(item.path) && !item.path.includes('\\') && !item.path.split('/').some(part => part === '..' || part === '.')); assert.ok(/^[a-f0-9]{64}$/.test(item.sha256)); assert.ok(!seen.has(item.path)); seen.add(item.path);
    const file = fs.realpathSync(path.join(component, item.path)); assert.ok(within(component, file)); assert.equal(fs.statSync(file).size, item.size); assert.equal(await sha256(file), item.sha256, `Manifest mismatch: ${item.path}`);
  }
  for (const name of [manifest.entry, ...Object.values(manifest.runtime)]) assert.ok(seen.has(name), `Runtime is not covered by manifest: ${name}`);
  return manifest;
}
function childEnvironment() {
  const env = { ...process.env, PATH: path.join(process.env.SystemRoot, 'System32'), DO_NOT_TRACK: '1' };
  for (const key of Object.keys(env)) if (/^(?:https?|all|no)_proxy$/i.test(key) || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  return env;
}
async function bundledProcess(config, mode, timeout = 300000) {
  const native = path.join(config.component, 'runtime', 'native', 'mediahub-pipe.exe');
  const node = path.join(config.component, 'runtime', 'node', 'node.exe');
  const child = spawn(native, ['job', '--', node, __filename, mode, config.configPath], { cwd: root, env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const output = { stdout: '', stderr: '', observed: [], processErrors: [] };
  const seen = new Map(); let sampling = false; let wrapperCreationDate = null;
  const sample = async () => {
    if (sampling) return; sampling = true;
    try {
      const snapshot = await powershell(processSnapshotScript(), 20000);
      const rows = Array.isArray(snapshot) ? snapshot : [snapshot];
      const wrapper = rows.find(row => row.ProcessId === child.pid);
      if (!wrapper || wrapper.Name?.toLowerCase() !== 'mediahub-pipe.exe' || !wrapper.CreationDate) return;
      if (wrapperCreationDate && wrapper.CreationDate !== wrapperCreationDate) return;
      wrapperCreationDate ||= wrapper.CreationDate;
      const owned = new Set([child.pid]); let changed = true;
      while (changed) { changed = false; for (const row of rows) if (owned.has(row.ParentProcessId) && !owned.has(row.ProcessId)) { owned.add(row.ProcessId); changed = true; } }
      for (const row of rows) if (owned.has(row.ProcessId)) mergeObservation(seen, row);
    } catch (error) { output.processErrors.push(error.message); } finally { sampling = false; }
  };
  const interval = setInterval(() => void sample(), 1250); void sample();
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  child.stdout.on('data', chunk => { output.stdout += chunk; if (output.stdout.length > 2 * 1024 * 1024) child.kill('SIGKILL'); });
  child.stderr.on('data', chunk => { output.stderr = (output.stderr + chunk).slice(-64 * 1024); });
  try {
    output.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  } finally { clearTimeout(timer); clearInterval(interval); child.kill('SIGKILL'); while (sampling) await pause(25); }
  output.observed = [...seen.values()];
  const evidence = classifyObservations(output.observed, config.component); output.processSummary = evidence.summary;
  // Preserve actual child diagnostics before any gate can reject the evidence.
  writeBoundedRaw(path.join(root, `${mode.slice(2)}.raw.json`), output);
  try {
    assert.equal(output.exitCode, 0, `Bundled ${mode} failed: ${redact(output.stderr.slice(-4000))}`);
    assert.equal(evidence.summary.outside, 0, 'An observed media runtime has a real path outside the package or lacks creation identity');
    assert.equal(evidence.summary.unknownAlive, 0, 'A still-live media runtime path could not be verified after immediate recheck');
    if (mode === '--isolated-stage') for (const name of ['node.exe', 'chrome-headless-shell.exe']) assert.ok(evidence.summary.verifiedRuntimeNames.includes(name), `No actual verified ${name} process sample was captured`);
    const lines = output.stdout.trim().split(/\r?\n/).filter(Boolean); const result = JSON.parse(lines.at(-1));
    return { result, ...evidence };
  } catch (error) { error.runtimeProcessSummary = evidence.summary; error.runtimeProcessEvidence = evidence.observed; throw error; }
}
async function tcpProbe(address, timeout = 8000) {
  return new Promise(resolve => {
    const socket = net.connect({ host: address, port: 443 }); let settled = false;
    const finish = value => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
    socket.setTimeout(timeout, () => finish({ connected: false, reason: 'timeout' })); socket.once('connect', () => finish({ connected: true })); socket.once('error', error => finish({ connected: false, reason: error.code || error.name }));
  });
}
async function configFrom(file) {
  assertHostedRunner(); const resolved = fs.realpathSync(file); assert.ok(within(root, resolved));
  const config = JSON.parse(await fsp.readFile(resolved, 'utf8')); config.configPath = resolved;
  config.component = fs.realpathSync(config.component); assert.ok(within(root, config.component)); assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(path.join(config.component, 'runtime', 'node', 'node.exe'))); assert.equal(process.version, 'v24.21.0'); assert.equal(process.env.PATH.toLowerCase(), path.join(process.env.SystemRoot, 'System32').toLowerCase()); assert.equal(net.isIP(config.externalAddress), 4);
  return config;
}
async function browserRuntime(config) {
  const { default: puppeteer } = await import(pathToFileURL(path.join(config.component, 'node_modules', 'puppeteer-core', 'lib', 'puppeteer', 'puppeteer-core.js')));
  return puppeteer.launch({ executablePath: path.join(config.component, 'runtime', 'chrome', 'chrome-headless-shell.exe'), headless: true, args: ['--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-proxy-server'] });
}
async function chromeProbe(browser, mustLoad) {
  const page = await browser.newPage(); let response; let failure;
  try {
    await page.setCacheEnabled(false);
    try { response = await page.goto('https://github.com/', { waitUntil: 'domcontentloaded', timeout: mustLoad ? 30000 : 12000 }); } catch (error) { failure = error.message; }
    if (mustLoad) { assert.ok(!failure && response && response.ok(), `Bundled Chrome public baseline failed: ${redact(failure || `HTTP ${response?.status()}`)}`); return { loaded: true, status: response.status(), origin: 'https://github.com' }; }
    assert.ok(failure, 'Bundled Chrome unexpectedly loaded an external page');
    return { loaded: false, reason: redact(failure).replace(/https?:\/\/[^\s]+/g, '[external-url]').slice(0, 200) };
  } finally { await page.close(); }
}
async function baselineStage(config) {
  const node = await tcpProbe(config.externalAddress); assert.equal(node.connected, true, 'Bundled Node must reach the public TCP endpoint before isolation');
  const browser = await browserRuntime(config);
  try { return { node, chrome: await chromeProbe(browser, true) }; } finally { await browser.close(); }
}
async function isolatedStage(config) {
  const tests = []; const events = []; const pending = new Map(); let nextId = 0;
  const node = path.join(config.component, 'runtime', 'node', 'node.exe'); const chrome = path.join(config.component, 'runtime', 'chrome', 'chrome-headless-shell.exe'); const ffprobe = path.join(config.component, 'runtime', 'ffmpeg', 'ffprobe.exe');
  const nodeBlocked = await tcpProbe(config.externalAddress); assert.equal(nodeBlocked.connected, false, 'The bundled Node still has external TCP access'); tests.push({ name: 'actual-node-network-block', passed: true, reason: nodeBlocked.reason });
  const manifest = JSON.parse(await fsp.readFile(path.join(config.component, 'manifest.json'), 'utf8'));
  const probeBinary = manifest.files.find(file => file.path === 'runtime/ffmpeg/ffprobe.exe'); assert.ok(probeBinary && /^[a-f0-9]{64}$/.test(probeBinary.sha256));
  const probeHash = await sha256(ffprobe); assert.equal(probeHash, probeBinary.sha256, 'Actual ffprobe binary does not match the verified package manifest');
  const browser = await browserRuntime(config);
  let service; let stderr = '';
  try {
    const chromeBlocked = await chromeProbe(browser, false); tests.push({ name: 'actual-chrome-network-block', passed: true, reason: chromeBlocked.reason });
    service = spawn(path.join(config.component, 'runtime', 'native', 'mediahub-pipe.exe'), ['job', '--', node, path.join(config.component, 'service-entry.mjs')], { cwd: config.component, env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const failPending = error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); };
    service.on('error', failPending); service.on('exit', code => failPending(new Error(`Adapter exited (${code}): ${stderr.slice(-1000)}`))); service.stdin.on('error', failPending); service.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-32000); });
    readline.createInterface({ input: service.stdout }).on('line', line => {
      let value; try { value = JSON.parse(line); } catch { return failPending(new Error('Adapter protocol was not valid NDJSON')); }
      if (value.event) { events.push(value); if (events.length > 2000) events.shift(); return; } const entry = pending.get(value.id); if (!entry) return; pending.delete(value.id); clearTimeout(entry.timer); value.error ? entry.reject(Object.assign(new Error(value.error.message), value.error)) : entry.resolve(value.result);
    });
    const call = (method, params = {}, timeout = 90000) => new Promise((resolve, reject) => { const id = `offline-${++nextId}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Adapter timed out: ${method}`)); }, timeout); pending.set(id, { resolve, reject, timer }); service.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
    const status = await call('status'); assert.equal(status.healthy, true); assert.equal(status.versions.node, '24.21.0'); assert.equal(status.versions.chrome, '152.0.7977.30'); assert.equal(status.versions.ffmpeg, '8.1.1');
    for (const key of ['node', 'chrome', 'ffmpeg', 'ffprobe', 'native', 'font']) assert.ok(within(config.component, status.runtime[key]));
    tests.push({ name: 'bundled-runtime-identity-and-system32-only-launch-path', passed: true, versions: status.versions });
    const sourceAsset = path.join(root, '共享素材 中文 空格.svg'); await fsp.writeFile(sourceAsset, '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#37d99b"/></svg>');
    const renders = [];
    for (const orientation of ['landscape', 'portrait']) {
      const projectDir = path.join(root, '工作空间 中文 空格', `${orientation} 工程`); const projectId = `project_offline_${orientation}`;
      const created = await call('create', { projectDir, projectId, title: `离线 ${orientation} 作品`, orientation, duration: 1 }); assert.equal(created.projectId, projectId);
      const imported = await call('import', { projectDir, assets: [{ assetId: 'asset_offline_shared', sourcePath: sourceAsset }] }); assert.equal(imported.assets[0].assetId, 'asset_offline_shared'); assert.equal(await sha256(path.join(projectDir, imported.assets[0].relativePath)), await sha256(sourceAsset));
      const urls = await call('preview', { projectDir }); assert.notEqual(new URL(urls.studioUrl).origin, new URL(urls.previewUrl).origin);
      const response = await fetch(urls.previewUrl, { signal: AbortSignal.timeout(45000) }); assert.equal(response.status, 200); assert.ok(!(await response.text()).includes(new URL(urls.studioUrl).searchParams.get('token')));
      const page = await browser.newPage(); const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message)); await page.setViewport({ width: 1440, height: 900 });
      await page.goto(urls.studioUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForFunction(title => document.getElementById('source')?.value.includes(title), { timeout: 20000 }, `离线 ${orientation} 作品`);
      const source = await fsp.readFile(created.entry, 'utf8'); await fsp.writeFile(created.entry, source.replaceAll(`离线 ${orientation} 作品`, `Agent 离线修改 ${orientation}`).replace('data-duration="1"', 'data-duration="2"'));
      await page.waitForFunction(title => document.getElementById('source')?.value.includes(title), { timeout: 20000 }, `Agent 离线修改 ${orientation}`); await page.waitForFunction(() => document.getElementById('seek')?.max === '2', { timeout: 20000 });
      const deadline = Date.now() + 20000; let refreshed = false;
      while (!refreshed && Date.now() < deadline) { const frame = page.frames().find(item => item.url().startsWith(new URL(urls.previewUrl).origin)); if (frame) refreshed = await frame.evaluate(title => window.__playerReady === true && document.querySelector('.title')?.textContent.includes(title), `Agent 离线修改 ${orientation}`).catch(() => false); if (!refreshed) await pause(100); }
      assert.equal(refreshed, true, 'Agent save did not refresh the actual preview frame'); assert.deepEqual(pageErrors, []);
      await page.screenshot({ path: path.join(root, `studio-${orientation}.png`), fullPage: true }); await page.close();
      const lint = await call('lint', { projectDir }); assert.equal(lint.ok, true, JSON.stringify(lint)); const check = await call('check', { projectDir }); assert.equal(check.ok, true, JSON.stringify(check)); assert.deepEqual(check.browser.blockedRequests, []);
      const taskId = `offline-render-${orientation}`; const accepted = await call('render', { projectDir, taskId, quality: 'draft' }); assert.equal(accepted.accepted, true);
      const end = Date.now() + 120000; let task;
      do { await pause(250); task = await call('status', { taskId }); } while (['queued', 'rendering', 'validating'].includes(task.status) && Date.now() < end);
      assert.equal(task.status, 'complete', task.error); assert.equal(task.mediaValidated, true); assert.equal(task.artifact.mediaValidated, true); assert.ok(events.some(event => event.event === 'progress' && event.taskId === taskId)); assert.ok(fs.statSync(task.outputPath).size > 1000);
      assert.equal(await sha256(ffprobe), probeHash, 'Bundled ffprobe changed before explicit validation');
      const probeStartedAt = new Date().toISOString();
      const { stdout } = await exec(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', task.outputPath], { env: childEnvironment(), windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }); const media = JSON.parse(stdout); const video = media.streams.find(stream => stream.codec_type === 'video');
      assert.equal(video.codec_name, 'h264'); assert.equal(video.width, orientation === 'landscape' ? 1920 : 1080); assert.equal(video.height, orientation === 'landscape' ? 1080 : 1920); assert.equal(video.avg_frame_rate, '30/1'); assert.ok(['yuv420p', 'yuvj420p'].includes(video.pix_fmt)); assert.ok(Number(media.format.duration) > 0);
      renders.push({ orientation, width: video.width, height: video.height, codec: video.codec_name, pixelFormat: video.pix_fmt, fps: video.avg_frame_rate, duration: Number(media.format.duration), bytes: fs.statSync(task.outputPath).size, sha256: await sha256(task.outputPath), sourceAssetIdPreserved: true, structuredProgress: true, mediaValidated: true, ffprobeReceipt: { binary: 'runtime/ffmpeg/ffprobe.exe', manifestSha256: probeBinary.sha256, actualSha256: probeHash, exitCode: 0, startedAt: probeStartedAt, completedAt: new Date().toISOString(), execution: 'execFile with the verified absolute bundled executable; receipt exists only after successful process exit' } });
      tests.push({ name: `offline-${orientation}-create-preview-agent-refresh-lint-browser-check-render-ffprobe`, passed: true });
    }
    const nodeAfter = await tcpProbe(config.externalAddress); assert.equal(nodeAfter.connected, false, 'Node isolation disappeared during rendering'); tests.push({ name: 'actual-node-network-block-after-render', passed: true, reason: nodeAfter.reason });
    const chromeAfter = await chromeProbe(browser, false); tests.push({ name: 'actual-chrome-network-block-after-render', passed: true, reason: chromeAfter.reason });
    await call('shutdown', { idleOnly: true }); await new Promise(resolve => service.exitCode !== null ? resolve() : service.once('close', resolve)); service = null;
    return { passed: true, tests, renders, networkIsolationRechecked: true, initialPath: 'Windows System32 only; adapter subsequently adds only its bundled Node/FFmpeg directories', protocol: 'native job wrapper + bundled Node service-entry.mjs; UTF-8 NDJSON RPC and structured progress events' };
  } finally { writeBoundedRaw(path.join(root, 'stage-protocol.raw.json'), { events, stderr, tests }); if (service) service.kill('SIGKILL'); await browser.close(); }
}
async function main() {
  assertHostedRunner();
  if (process.argv[2] === '--cleanup') { process.stdout.write(JSON.stringify(await removeRules()) + '\n'); return; }
  if (process.argv[2] === '--baseline' || process.argv[2] === '--isolated-stage') {
    const config = await configFrom(process.argv[3]); const result = process.argv[2] === '--baseline' ? await baselineStage(config) : await isolatedStage(config); process.stdout.write(JSON.stringify(result) + '\n'); return;
  }
  const pkg = acceptedPackage(process.env.MEDIAHUB_COMPONENT_URL, process.env.MEDIAHUB_COMPONENT_SHA256);
  if (fs.existsSync(root)) throw new Error('Acceptance requires a fresh work/offline-acceptance directory in a new disposable runner.');
  await fsp.mkdir(root, { recursive: true });
  const report = { schema: 1, passed: false, startedAt: new Date().toISOString(), completedAt: null, profile: 'disposable-github-hosted-windows', run: { id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, sha: process.env.GITHUB_SHA }, component: pkg, isolation: { scope: 'Only the verified component Node, Chrome, FFmpeg and FFprobe executables; host runner networking and firewall defaults stay unchanged', method: 'temporary Windows outbound firewall rules exclude IPv4 loopback and IPv6 ::1' }, tests: [], limits: ['Component network isolation is real and measured; the entire GitHub VM is not disconnected.', 'Studio is tested with bundled headless Chrome; this workflow does not test the platform Electron window, installer, or component upgrade.'] };
  const before = await firewallState(); report.firewallBefore = before;
  let rulesCreated = false;
  try {
    assert.equal(before.service, 'Running', 'Firewall service must already be running; this script never enables it or changes global settings');
    assert.ok(before.profiles.some(profile => profile.Enabled === true || profile.Enabled === 1), 'Firewall profiles must already be enabled; this script never changes global settings');
    const archive = path.join(root, 'component.zip'); report.component.bytes = await download(pkg, archive); const component = path.join(root, '组件 中文 空格');
    await require('../desktop/core/packages.cjs').extractZip(archive, component); const manifest = await verifyManifest(component, pkg.version); report.component.manifestFilesVerified = manifest.files.length;
    const { address } = await dns.lookup('github.com', { family: 4 }); const config = { component, configPath: path.join(root, 'config.json'), externalAddress: address }; atomicJson(config.configPath, config);
    const baseline = await bundledProcess(config, '--baseline', 90000); assert.equal(baseline.result.node.connected, true); assert.equal(baseline.result.chrome.loaded, true); report.networkBaseline = baseline.result; report.tests.push({ name: 'public-node-and-chrome-network-baseline-before-rules', passed: true });
    rulesCreated = true; const rules = await installRules(component); report.isolation.rules = rules.map(rule => ({ program: path.relative(component, rule.program).replaceAll('\\', '/'), action: rule.action, direction: rule.direction, remoteAddress: rule.remoteAddress }));
    const isolated = await bundledProcess(config, '--isolated-stage', 420000); assert.equal(isolated.result.passed, true); assert.equal(isolated.result.renders.length, 2); assert.equal(isolated.result.networkIsolationRechecked, true); report.tests.push(...isolated.result.tests); report.renders = isolated.result.renders; report.isolation.recheckedAfterRender = isolated.result.networkIsolationRechecked; report.runtimeProcesses = isolated.observed; report.runtimeProcessSummary = isolated.summary; report.runtimeProcessesOutsidePackage = isolated.summary.outside; report.runtimeProcessesUnknownExited = isolated.summary.unknownExited; report.runtimeProcessesUnknownAlive = isolated.summary.unknownAlive; assert.equal(report.runtimeProcessesOutsidePackage, 0); assert.equal(report.runtimeProcessesUnknownAlive, 0);
    if (isolated.summary.unknownExited) report.limits.push('Some short-lived runtime instances exited before their image paths could be queried; these samples are listed as unknownExited, not verified. The two explicit bundled FFprobe executions have independently checked binary hashes and successful exit receipts.');
    report.passed = true;
  } catch (error) {
    if (error.runtimeProcessSummary) { report.runtimeProcessSummary = error.runtimeProcessSummary; report.runtimeProcesses = error.runtimeProcessEvidence; report.runtimeProcessesOutsidePackage = error.runtimeProcessSummary.outside; report.runtimeProcessesUnknownExited = error.runtimeProcessSummary.unknownExited; report.runtimeProcessesUnknownAlive = error.runtimeProcessSummary.unknownAlive; }
    report.error = { code: error.code || error.name, message: redact(error.message).slice(0, 3000) }; throw error;
  } finally {
    try { if (rulesCreated) { report.cleanup = await removeRules(); assert.equal(report.cleanup.remaining, 0, 'Temporary firewall rules remain'); } else report.cleanup = { removed: 0, remaining: 0 }; report.firewallAfter = await firewallState(); assert.deepEqual(report.firewallAfter, before, 'Firewall service/profile/default policy changed during acceptance'); }
    catch (error) { report.passed = false; report.cleanupError = redact(error.message); process.exitCode = 1; }
    report.completedAt = new Date().toISOString(); atomicJson(path.join(root, 'report.public.json'), report);
    process.stdout.write(JSON.stringify({ passed: report.passed, tests: report.tests.length, cleanup: report.cleanup, report: 'work/offline-acceptance/report.public.json' }) + '\n');
  }
}
module.exports = { assertHostedRunner, acceptedPackage, ruleGroup, processSnapshotScript, mergeObservation, classifyObservations };
if (require.main === module) main().catch(error => { process.stderr.write(redact(error.stack || error) + '\n'); process.exitCode = 1; });
