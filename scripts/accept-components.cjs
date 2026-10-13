'use strict';
// Real component lifecycle acceptance. The operator publishes the signed v1/v2
// catalogs between phases; this driver never changes a feed or release asset.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { verifyEnvelope } = require('../desktop/core/catalog.cjs');
const { exeVersion } = require('./accept-upgrade.cjs');

const REPO = path.resolve(__dirname, '..');
const BASE = path.join(REPO, 'work', 'component-acceptance');
const CATALOG_URL = 'https://raw.githubusercontent.com/jerryrenjianxing-sys/MediaHub/distribution/catalog/catalog.signed.json';
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const EXPECTED_RUNTIME = { node: '24.21.0', chrome: '152.0.7977.30', ffmpeg: '8.1.1', hyperframes: '0.8.151' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function within(root, target) { const rel = path.relative(path.resolve(root), path.resolve(target)); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function writeJson(file, value) { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n'); fs.renameSync(tmp, file); }
async function hash(file) { const value = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) value.update(chunk); return value.digest('hex'); }
function optionsFor(argv) {
  const options = { runId: '', timeoutMinutes: 30 };
  const names = { '--phase': 'phase', '--app-exe': 'appExe', '--expected-tool-version': 'toolVersion', '--run-id': 'runId', '--timeout-minutes': 'timeoutMinutes' };
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--help') return { help: true }; const key = names[argv[i]]; if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Invalid option: ${argv[i]}`); options[key] = argv[++i]; }
  assert.ok(['install-v1', 'upgrade-v2'].includes(options.phase), 'Choose install-v1 or upgrade-v2');
  assert.ok(options.appExe && options.toolVersion, 'Required: --app-exe and --expected-tool-version');
  assert.match(options.toolVersion, /^\d+\.\d+\.\d+-preview\.\d+$/, 'Use the actual published preview component version');
  assert.match(options.runId, /^[a-zA-Z0-9-]{0,60}$/, 'run-id must be a simple directory name');
  options.timeoutMinutes = Number(options.timeoutMinutes); assert.ok(options.timeoutMinutes >= 5 && options.timeoutMinutes <= 90);
  options.appExe = path.resolve(options.appExe);
  assert.ok(within(path.join(REPO, 'release'), options.appExe) || within(path.join(REPO, 'work'), options.appExe), 'Use a packaged app from release/win-unpacked or an isolated ZIP extraction under work');
  assert.equal(path.basename(options.appExe).toLowerCase(), 'mediahub.exe');
  return options;
}
function program(executable, args, { input = '', timeout = 120000, env = process.env, ...extra } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env, ...extra });
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error(`${path.basename(executable)} timed out`)); }, timeout);
    function finish(error, value) { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); }
    child.once('error', error => finish(error)); child.stdout.on('data', value => { stdout += value.toString('utf8'); if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) { child.kill(); finish(new Error('Acceptance response exceeds 2 MiB')); } });
    child.stderr.on('data', value => { if (stderr.length < 16000) stderr += value.toString('utf8'); });
    child.once('close', code => code === 0 ? finish(null, { stdout, stderr, code }) : finish(new Error(`${path.basename(executable)} exited ${code}: ${stderr.trim().slice(0, 1500)}`)));
    child.stdin.end(input);
  });
}
async function powershell(script, params = {}) {
  const prefix = '$ErrorActionPreference="Stop";[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$inputRecord=[Console]::In.ReadToEnd()|ConvertFrom-Json;';
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await program(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(prefix + script, 'utf16le').toString('base64')], { input: JSON.stringify(params), timeout: 45000 });
  return JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ''));
}
const PROCESS_SCRIPT = `$all=@(Get-CimInstance Win32_Process -ErrorAction Stop);$ids=[Collections.Generic.HashSet[int]]::new();[void]$ids.Add([int]$inputRecord.appPid);$changed=$true;while($changed){$changed=$false;foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)){[void]$ids.Add([int]$p.ProcessId);$changed=$true}}};$items=@();foreach($p in $all){if($ids.Contains([int]$p.ProcessId)){$items+=@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;path=$p.ExecutablePath;name=$p.Name;commandLine=$p.CommandLine;createdAt=$p.CreationDate.ToUniversalTime().ToString('o')}}};$network=@();$networkAvailable=$true;try{foreach($c in Get-NetTCPConnection -ErrorAction Stop){if($ids.Contains([int]$c.OwningProcess)){$network+=@{pid=[int]$c.OwningProcess;remoteAddress=$c.RemoteAddress;remotePort=$c.RemotePort;state=[string]$c.State}}}}catch{$networkAvailable=$false};@{processes=@($items);connections=@($network);networkAvailable=$networkAvailable}|ConvertTo-Json -Depth 8 -Compress`;
function renderTree(processes, componentRoot) {
  const roots = processes.filter(p => within(componentRoot, p.path || '') && String(p.commandLine || '').includes('render-worker.mjs'));
  const ids = new Set(roots.map(p => p.pid));
  // Both the native Job Object wrapper and its Node worker include render-worker.
  let changed = true; while (changed) { changed = false; for (const process of processes) if (ids.has(process.parentPid) && !ids.has(process.pid)) { ids.add(process.pid); changed = true; } }
  return processes.filter(p => ids.has(p.pid));
}
async function remainingProcesses(records) {
  if (!records.length) return [];
  return powershell('$items=@();foreach($record in $inputRecord.records){$p=Get-CimInstance Win32_Process -Filter ("ProcessId="+[int]$record.pid) -ErrorAction SilentlyContinue;if($p -and $p.CreationDate.ToUniversalTime().ToString("o") -eq $record.createdAt){$items+=@{pid=[int]$p.ProcessId;createdAt=$p.CreationDate.ToUniversalTime().ToString("o")}}};ConvertTo-Json -InputObject @($items) -Compress', { records: records.map(record => ({ pid: record.pid, createdAt: record.createdAt })) });
}
async function noProcesses(records, timeout = 45000) {
  const deadline = Date.now() + timeout; let remaining = records;
  while (Date.now() < deadline) { remaining = await remainingProcesses(records); if (!remaining.length) return; await pause(500); }
  throw new Error(`Owned process group did not stop (${remaining.length} processes)`);
}
function changeDuration(source, duration) {
  assert.ok(source.includes('data-duration="'), 'Acceptance composition must have a duration');
  return source.replace(/(data-duration=")[0-9.]+(")/, (_match, left, right) => `${left}${duration}${right}`).replace(/(\.to\('\.orb',\{x:-100,y:-80,duration:)[0-9.]+(,ease:)/, (_match, left, right) => `${left}${duration}${right}`);
}
function safeError(message) { return String(message || '').replaceAll(REPO, '<repo>').replaceAll(REPO.replaceAll('\\', '/'), '<repo>').replace(/[A-Za-z]:[\\/][^\n\r"']*/g, '<local-path>'); }
function summaryFor(report) {
  return { schema: 1, phase: report.phase, passed: report.passed, startedAt: report.startedAt, completedAt: report.completedAt, platformVersion: report.platformVersion, toolVersion: report.toolVersion, catalog: report.catalog && { url: report.catalog.url, signed: true, sha256: report.catalog.sha256, packageUrl: report.catalog.packageUrl, packageSha256: report.catalog.packageSha256, packageBytes: report.catalog.packageBytes }, runtime: report.runtime, tests: report.tests.map(test => ({ name: test.name, passed: test.passed, completedAt: test.completedAt, metrics: test.metrics })), taskProgress: report.taskProgress.map(item => ({ name: item.name, state: item.state, phase: item.phase, percent: item.percent, at: item.at })), offlineEvidence: report.offlineEvidence, error: report.error ? { message: safeError(report.error.message) } : undefined };
}
async function fetchCatalog(appDirectory, expectedVersion) {
  const publicKey = fs.readFileSync(path.join(appDirectory, 'resources', 'resources', 'catalog-public.pem'), 'utf8');
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(30000), headers: { 'Cache-Control': 'no-cache' } }); assert.equal(response.status, 200, 'Real signed catalog must be published before this phase'); const text = await response.text(); assert.ok(text.length < 2 * 1024 * 1024); const catalog = verifyEnvelope(JSON.parse(text), publicKey); const tool = catalog.tools.find(item => item.id === 'hyperframes'); assert.equal(tool?.version, expectedVersion, 'Public catalog is not the expected component version'); assert.ok(tool.package.url.startsWith('https://github.com/jerryrenjianxing-sys/MediaHub/releases/download/')); return { catalog, tool, evidence: { url: CATALOG_URL, sha256: crypto.createHash('sha256').update(text).digest('hex'), packageUrl: tool.package.url, packageSha256: tool.package.sha256, packageBytes: tool.package.bytes } }; }
    catch (error) { lastError = error; if (attempt < 2) await pause(1000); }
  }
  throw lastError;
}
async function locateDownloadedPackage(dataRoot, descriptor) {
  const dir = path.join(dataRoot, 'downloads'); assert.ok(fs.existsSync(dir), 'Component download cache missing');
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isFile() && /^hyperframes-.*\.zip$/i.test(entry.name)) { const file = path.join(dir, entry.name); if (fs.statSync(file).size === descriptor.bytes && await hash(file) === descriptor.sha256) return file; }
  throw new Error('No actual verified component ZIP exists in this profile download cache');
}

async function main(argv = process.argv.slice(2)) {
  const options = optionsFor(argv);
  if (options.help) { console.log('Usage: node scripts/accept-components.cjs --phase install-v1|upgrade-v2 --app-exe <packaged MediaHub.exe> --expected-tool-version <actual preview version> [--run-id <isolated name>] [--timeout-minutes 30]\nThe operator must publish the real signed catalog for each phase. Phase 1 saves a checkpoint; phase 2 updates and uninstalls using the same profile. All app launches use PATH=System32; no system runtime or production data is modified.'); return; }
  assert.equal(process.platform, 'win32'); assert.ok(fs.existsSync(options.appExe));
  const acceptanceRoot = options.runId ? path.join(BASE, options.runId) : BASE;
  const appDirectory = path.dirname(fs.realpathSync(options.appExe));
  const dataRoot = path.join(acceptanceRoot, 'data'); const workspaceRoot = path.join(acceptanceRoot, '共享 项目与素材');
  const profileFile = path.join(acceptanceRoot, 'profile.json'); const checkpointFile = path.join(acceptanceRoot, 'checkpoint.json');
  if (options.phase === 'install-v1') assert.ok(!fs.existsSync(profileFile), 'Phase 1 requires a fresh profile; choose a new --run-id instead of deleting user files');
  else { assert.ok(fs.existsSync(checkpointFile), 'Complete install-v1 with this profile before upgrade-v2'); assert.equal(readJson(checkpointFile).phase1Passed, true); }
  const published = await fetchCatalog(appDirectory, options.toolVersion);
  const peInfo = await exeVersion(options.appExe); assert.equal(peInfo.productName, 'MediaHub');
  fs.mkdirSync(acceptanceRoot, { recursive: true }); fs.mkdirSync(dataRoot, { recursive: true });
  if (options.phase === 'install-v1') writeJson(profileFile, { acceptance: true, dataRoot, workspaceRoot });
  const profile = readJson(profileFile); assert.equal(profile.acceptance, true); assert.equal(path.resolve(profile.dataRoot).toLowerCase(), dataRoot.toLowerCase()); assert.equal(path.resolve(profile.workspaceRoot).toLowerCase(), workspaceRoot.toLowerCase());
  const report = { phase: options.phase, passed: false, startedAt: new Date().toISOString(), completedAt: null, platformVersion: peInfo.fileVersion, toolVersion: options.toolVersion, catalog: published.evidence, runtime: null, tests: [], taskProgress: [], offlineEvidence: { systemPathOnly: true, absoluteBundledRuntimePaths: false, browserRemoteRequestInterception: false, remoteAuthoredRequests: 0, runtimePublicTcpConnections: 0, networkObservationAvailable: true, physicalNetworkDisconnected: false, limitation: 'The host network is left intact. Offline resource independence is verified through the actual browser check and observations of owned runtime processes; this is not a physical disconnection test.' }, private: { appExe: options.appExe, dataRoot, workspaceRoot } };
  let activeApp = null; let componentRoot = null;
  const save = () => { writeJson(path.join(acceptanceRoot, `${options.phase}.report.json`), report); writeJson(path.join(acceptanceRoot, `${options.phase}.public.json`), summaryFor(report)); };
  function complete(name, metrics = {}) { report.tests.push({ name, passed: true, completedAt: new Date().toISOString(), metrics }); save(); console.log(`PASS ${name}`); }
  function start() {
    const env = { ...process.env, PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') }; delete env.ELECTRON_RUN_AS_NODE; delete env.MEDIAHUB_PROFILE;
    const child = spawn(options.appExe, ['--mediahub-profile', profileFile], { cwd: appDirectory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = fs.createWriteStream(path.join(acceptanceRoot, `app-${Date.now()}.log`)); child.stdout.pipe(log); child.stderr.pipe(log); child.once('close', () => log.end());
    activeApp = { child, error: null }; child.once('error', error => { if (activeApp?.child === child) activeApp.error = error; }); return activeApp;
  }
  function connection() {
    assert.ok(activeApp, 'No owned application is running'); const value = readJson(path.join(dataRoot, 'connection.json'));
    assert.equal(value.protocol, 1); assert.equal(value.transport, 'windows-named-pipe'); assert.equal(value.acceptance, true); assert.equal(value.pid, activeApp.child.pid);
    assert.match(value.pipe, /^[a-zA-Z0-9_.-]{1,160}$/); assert.ok(within(appDirectory, fs.realpathSync(value.clientPath)), 'Native transport is not from this packaged app'); return value;
  }
  async function call(method, params = {}, timeout = 180000) {
    const value = connection(); const id = crypto.randomUUID(); const response = await program(value.clientPath, ['client', '--pipe', value.pipe], { input: JSON.stringify({ protocol: 1, id, method, params }) + '\n', timeout });
    const receipt = JSON.parse(response.stdout.trim()); assert.equal(receipt.id, id); if (receipt.ok !== true) throw Object.assign(new Error(receipt.error?.message || 'Platform call failed'), { code: receipt.error?.code }); return receipt.result;
  }
  async function ready() {
    const deadline = Date.now() + 120000; let error;
    while (Date.now() < deadline) { if (activeApp.error) throw activeApp.error; if (activeApp.child.exitCode !== null) throw new Error('Owned app exited before its pipe became ready'); try { const value = await call('platform.snapshot', {}, 15000); if (value.connection?.available) { assert.equal(value.version, peInfo.fileVersion); assert.equal(value.connection.profile, 'acceptance'); assert.equal(path.resolve(value.workspace.path).toLowerCase(), workspaceRoot.toLowerCase()); return value; } } catch (cause) { error = cause; } await pause(300); }
    throw new Error(`Packaged app did not become ready: ${error?.message || 'unknown'}`);
  }
  async function evidence() {
    const value = await powershell(PROCESS_SCRIPT, { appPid: activeApp.child.pid });
    const runtimeIds = new Set(value.processes.filter(p => componentRoot && p.path && within(componentRoot, p.path)).map(p => p.pid));
    const remote = value.connections.filter(c => runtimeIds.has(c.pid) && c.state === 'Established' && !/^(127\.|::1$|0\.0\.0\.0$|::$)/.test(c.remoteAddress));
    report.offlineEvidence.runtimePublicTcpConnections += remote.length; report.offlineEvidence.networkObservationAvailable &&= value.networkAvailable; save();
    assert.equal(remote.length, 0, 'Owned tool runtime opened a public TCP connection during the local workflow'); return value;
  }
  async function task(id, name, { expected = 'completed', onUpdate, timeout = options.timeoutMinutes * 60000 } = {}) {
    const deadline = Date.now() + timeout; let signature;
    while (Date.now() < deadline) { const value = await call('tasks.get', { taskId: id }, 30000); const next = `${value.state}|${value.progress?.phase}|${Math.floor(value.progress?.percent || 0)}`; if (next !== signature) { signature = next; const row = { name, taskId: id, state: value.state, phase: value.progress?.phase, percent: value.progress?.percent, at: new Date().toISOString() }; report.taskProgress.push(row); fs.appendFileSync(path.join(acceptanceRoot, `${options.phase}.tasks.jsonl`), JSON.stringify(row) + '\n'); save(); } await onUpdate?.(value); if (TERMINAL.has(value.state)) { assert.equal(value.state, expected, `${name}: ${value.error?.message || 'unexpected terminal state'}`); return value; } await pause(1000); }
    throw new Error(`${name} exceeded its acceptance timeout`);
  }
  async function invoke(action, project, options = {}, waitOptions = {}) { const receipt = await call('capabilities.invoke', { capabilityId: `hyperframes.${action}`, projectId: project.id, options }); assert.ok(receipt.id, 'Platform did not return a real task ID'); return task(receipt.id, `${action} ${project.orientation}`, waitOptions); }
  async function stopPreview(project) { const value = await invoke('stop', project); assert.equal(value.result?.stopped, true); }
  async function validateRuntime(tool) {
    assert.equal(tool.installedVersion, options.toolVersion); assert.ok(within(path.join(dataRoot, 'components', 'hyperframes'), fs.realpathSync(tool.installPath)));
    componentRoot = fs.realpathSync(tool.installPath); const manifest = readJson(path.join(componentRoot, 'manifest.json')); const lock = readJson(path.join(componentRoot, 'runtime-lock.json'));
    assert.equal(manifest.id, 'hyperframes'); assert.equal(manifest.version, options.toolVersion); assert.equal(manifest.upstreamVersion, EXPECTED_RUNTIME.hyperframes); assert.equal(lock.versions.tool, options.toolVersion);
    const files = Object.fromEntries(['node', 'chrome', 'ffmpeg', 'ffprobe'].map(name => { const file = path.resolve(componentRoot, manifest.runtime[name]); assert.ok(within(componentRoot, file)); return [name, file]; }));
    for (const [name, file] of Object.entries(files)) { const record = manifest.files.find(entry => entry.path === path.relative(componentRoot, file).replaceAll('\\', '/')); assert.ok(record, `Runtime inventory missing ${name}`); assert.equal(await hash(file), record.sha256); }
    const coldEnv = { ...process.env, PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') }; delete coldEnv.ELECTRON_RUN_AS_NODE;
    const actual = {};
    for (const [name, args] of [['node', ['--version']], ['chrome', ['--version']], ['ffmpeg', ['-version']], ['ffprobe', ['-version']]]) { const output = await program(files[name], args, { env: coldEnv }); const text = output.stdout + output.stderr; const expected = name === 'ffprobe' ? EXPECTED_RUNTIME.ffmpeg : EXPECTED_RUNTIME[name]; assert.ok(text.includes(expected), `${name} actual version differs from lock`); actual[name] = expected; }
    const exported = await program(files.node, ['--input-type=module', '-e', 'const m=await import(process.argv[1]);process.stdout.write(JSON.stringify(m.versions));', pathToFileURL(path.join(componentRoot, 'runtime.mjs')).href], { env: coldEnv });
    const versions = JSON.parse(exported.stdout); assert.equal(versions.tool, options.toolVersion); for (const [name, version] of Object.entries(EXPECTED_RUNTIME)) assert.equal(versions[name], version);
    assert.equal(await hash(files.ffmpeg), lock.sources.ffmpeg.hashes['ffmpeg.exe']); assert.equal(await hash(files.ffprobe), lock.sources.ffmpeg.hashes['ffprobe.exe']); assert.equal(await hash(path.join(componentRoot, lock.sources.ffmpeg.sourceArchive)), lock.sources.ffmpeg.sourceArchiveSha256);
    report.runtime = { ...actual, hyperframes: versions.hyperframes, gsap: versions.gsap, componentIdentityVerified: true, runtimeHashesVerified: true, correspondingFfmpegSourceVerified: true }; report.offlineEvidence.absoluteBundledRuntimePaths = true; save(); return files;
  }
  async function browserCheck(project) {
    const result = await invoke('check', project, {}, { onUpdate: () => evidence() }); assert.equal(result.result?.ok, true); assert.equal(result.result.browser?.ok, true);
    assert.equal(result.result.browser.blockedRequests.length, 0); assert.equal(result.result.browser.dimensionsOk, true); assert.equal(result.result.browser.seekOk, true); report.offlineEvidence.browserRemoteRequestInterception = true;
    assert.ok(result.result.browser.sampled.every(sample => sample.timelineCount > 0)); complete(`真实浏览器检查 ${project.orientation}`, { sampledFrames: result.result.browser.sampled.length, remoteAuthoredRequests: 0 });
  }
  async function media(taskResult, project, runtime) {
    assert.equal(taskResult.result?.mediaValidated, true); const snapshot = await call('platform.snapshot'); const artifact = snapshot.artifacts.find(item => item.taskId === taskResult.id); assert.ok(artifact, 'Successful actual render did not register an artifact');
    assert.ok(within(path.join(project.path, 'renders'), fs.realpathSync(artifact.path))); const result = await program(runtime.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', artifact.path]);
    const decoded = JSON.parse(result.stdout); const video = decoded.streams.find(stream => stream.codec_type === 'video');
    assert.equal(video.codec_name, 'h264'); assert.equal(video.width, project.orientation === 'portrait' ? 1080 : 1920); assert.equal(video.height, project.orientation === 'portrait' ? 1920 : 1080); assert.equal(video.avg_frame_rate, '30/1'); assert.equal(video.pix_fmt, 'yuv420p'); assert.ok(Number(decoded.format.duration) > 0);
    return { id: artifact.id, taskId: taskResult.id, path: artifact.path, sha256: await hash(artifact.path), media: { codec: video.codec_name, width: video.width, height: video.height, fps: video.avg_frame_rate, pixelFormat: video.pix_fmt, duration: Number(decoded.format.duration) } };
  }
  async function activeRender(project, collected) {
    const receipt = await call('capabilities.invoke', { capabilityId: 'hyperframes.render', projectId: project.id, options: {} }); assert.ok(receipt.id);
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) { const value = await call('tasks.get', { taskId: receipt.id }); if (TERMINAL.has(value.state)) throw new Error('Long acceptance render ended before a live frame/progress could be observed'); const observed = await evidence(); const render = renderTree(observed.processes, componentRoot); for (const process of render) if (!collected.some(record => record.pid === process.pid && record.createdAt === process.createdAt)) collected.push(process); if (value.state === 'running' && Number(value.progress?.percent) > 0 && render.some(process => /chrome-headless-shell/i.test(process.name))) { const row = { name: 'live long render', taskId: value.id, state: value.state, phase: value.progress.phase, percent: value.progress.percent, at: new Date().toISOString() }; report.taskProgress.push(row); save(); return value; } await pause(500); }
    throw new Error('No live bundled Chrome render and structured progress were observed');
  }
  async function quit(mode = 'wait') { if (!activeApp) return; const record = activeApp; await call('platform.quit', { mode }, 30000).catch(error => { if (!/pipe|connection|closed|exit|response/i.test(error.message)) throw error; }); const deadline = Date.now() + 90000; while (record.child.exitCode === null && record.child.signalCode === null && Date.now() < deadline) await pause(250); assert.ok(record.child.exitCode !== null || record.child.signalCode !== null, 'Owned app did not quit'); activeApp = null; }
  try {
    save(); start(); const initial = await ready();
    assert.ok(initial.tools.filter(tool => tool.id !== 'hyperframes').every(tool => tool.status === 'not-installed'), 'Original production tools must not be registered in this acceptance profile');
    if (options.phase === 'install-v1') {
      assert.equal(initial.tools.find(tool => tool.id === 'hyperframes').status, 'not-installed'); assert.equal(fs.readdirSync(path.join(dataRoot, 'downloads')).length, 0);
      complete('空平台不自动下载工具', { registeredTools: initial.tools.length, downloadedFiles: 0 });
      const tools = await call('tools.list', { refresh: true }); assert.equal(tools.find(tool => tool.id === 'hyperframes').availableVersion, options.toolVersion);
      const install = await call('tools.install', { toolId: 'hyperframes' }); await task(install.id, '真实 GitHub 下载与安装');
      await locateDownloadedPackage(dataRoot, published.tool.package); const installed = (await call('platform.snapshot')).tools.find(tool => tool.id === 'hyperframes'); const runtime = await validateRuntime(installed);
      complete('真实 signed catalog 与按需组件安装', { installedVersion: installed.installedVersion, packageBytes: published.tool.package.bytes, packageSha256: published.tool.package.sha256 });
      const projects = [];
      for (const orientation of ['landscape', 'portrait']) { const project = await call('projects.create', { name: `组件验收 ${orientation === 'portrait' ? '竖屏' : '横屏'} 中文与空格`, orientation }); assert.ok(within(workspaceRoot, project.path)); await invoke('create', project, { duration: 1 }); const meta = readJson(path.join(project.path, 'mediahub-hyperframes.json')); assert.equal(meta.id, project.id); assert.equal(meta.orientation, orientation); projects.push(project); }
      const input = path.join(acceptanceRoot, '中文 logo 素材.png'); await program(runtime.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x147d6a:s=64x64:r=1', '-frames:v', '1', '-y', input]);
      const asset = await call('assets.import', { path: input }); assert.equal(asset.sha256, await hash(input)); assert.ok(within(workspaceRoot, asset.path));
      for (const project of projects) { await invoke('import', project, { assetId: asset.id }); const mapping = readJson(path.join(project.path, 'mediahub-hyperframes.json')).assets.find(item => item.assetId === asset.id); assert.ok(mapping); assert.equal(mapping.sha256, asset.sha256); assert.equal(await hash(path.join(project.path, mapping.relativePath)), asset.sha256);
        const entry = path.join(project.path, 'index.html'); let source = fs.readFileSync(entry, 'utf8'); source = source.replace(/(<h1 class="title">)[\s\S]*?(<\/h1>)/, `$1本地修改 中文与空格 验收$2`).replace('<div class="orb" data-layout-ignore="true"></div>', `<div class="orb" data-layout-ignore="true"></div><img data-layout-ignore="true" alt="验收素材" src="./${mapping.relativePath}" style="position:absolute;left:32px;top:32px;width:64px;height:64px;z-index:3">`); fs.writeFileSync(entry, source);
        const preview = await invoke('preview', project); const response = await fetch(preview.result.previewUrl, { signal: AbortSignal.timeout(15000) }); assert.equal(response.status, 200); assert.ok((await response.text()).includes('本地修改 中文与空格 验收')); const lint = await invoke('lint', project); assert.equal(lint.result.ok, true); await browserCheck(project); }
      complete('中文共享素材 source ID 与横竖工程修改', { orientations: 2, sameSourceId: true, sourceSha256: asset.sha256 });
      const artifacts = [];
      for (const project of projects) { const rendered = await invoke('render', project, {}, { onUpdate: () => evidence() }); const artifact = await media(rendered, project, runtime); artifacts.push(artifact); complete(`实际 MP4 与成功成果登记 ${project.orientation}`, artifact.media); }
      const landscape = projects[0]; const entry = path.join(landscape.path, 'index.html'); const preservedSource = fs.readFileSync(entry, 'utf8');
      fs.writeFileSync(entry, preservedSource.replace('</head>', '<script src="https://example.invalid/forbidden.js"></script></head>'));
      const failed = await invoke('render', landscape, {}, { expected: 'failed' }); assert.ok(!(await call('platform.snapshot')).artifacts.some(item => item.taskId === failed.id)); fs.writeFileSync(entry, preservedSource); complete('失败任务不登记成片');
      fs.writeFileSync(entry, changeDuration(preservedSource, 40)); const cancelledProcesses = []; const live = await activeRender(landscape, cancelledProcesses); await call('tasks.cancel', { taskId: live.id }); await task(live.id, '真实取消 40 秒工程', { expected: 'cancelled' }); await noProcesses(cancelledProcesses); assert.ok(!(await call('platform.snapshot')).artifacts.some(item => item.taskId === live.id)); fs.writeFileSync(entry, preservedSource);
      complete('40 秒工程真实进度与任务进程组取消', { positiveProgressObserved: true, stoppedRenderProcesses: cancelledProcesses.length, artifactRegistered: false });
      fs.writeFileSync(entry, changeDuration(preservedSource, 12)); const trayProcesses = []; const trayTask = await activeRender(landscape, trayProcesses); const hidden = await call('acceptance.window', { action: 'close' }); assert.equal(hidden.visible, false); assert.equal(activeApp.child.exitCode, null); const trayResult = await task(trayTask.id, '托盘继续真实渲染', { onUpdate: () => evidence() }); const trayArtifact = await media(trayResult, landscape, runtime); artifacts.push(trayArtifact); const shown = await call('acceptance.window', { action: 'show' }); assert.equal(shown.visible, true); fs.writeFileSync(entry, preservedSource); complete('关闭窗口到托盘仍完成成片', { ...trayArtifact.media, appRemainedAlive: true });
      const interruptedProcesses = []; fs.writeFileSync(entry, changeDuration(preservedSource, 40)); const interrupted = await activeRender(landscape, interruptedProcesses); const beforeKill = await call('platform.snapshot'); const allOwned = (await evidence()).processes.filter(record => record.pid !== activeApp.child.pid); const killed = activeApp.child;
      assert.equal(killed.kill('SIGKILL'), true); const killDeadline = Date.now() + 60000; while (killed.exitCode === null && killed.signalCode === null && Date.now() < killDeadline) await pause(100); assert.ok(killed.exitCode !== null || killed.signalCode !== null); activeApp = null; await noProcesses(allOwned);
      start(); const restarted = await ready(); const unknown = await call('tasks.get', { taskId: interrupted.id }); assert.equal(unknown.state, 'interrupted'); assert.ok(!restarted.artifacts.some(item => item.taskId === interrupted.id)); const taskIds = restarted.tasks.map(item => item.id).sort(); await pause(3000); const afterQuiet = await call('platform.snapshot'); assert.deepEqual(afterQuiet.tasks.map(item => item.id).sort(), taskIds); assert.ok(afterQuiet.tasks.every(item => TERMINAL.has(item.state))); const ownedAfterRestart = await evidence(); assert.ok(!ownedAfterRestart.processes.some(record => record.path && within(componentRoot, record.path)), 'Unexpected restart replayed or restarted a tool process');
      for (const artifact of artifacts) { assert.ok(afterQuiet.artifacts.some(item => item.id === artifact.id)); assert.equal(await hash(artifact.path), artifact.sha256); } fs.writeFileSync(entry, preservedSource);
      assert.equal(beforeKill.tasks.filter(item => !TERMINAL.has(item.state)).length, 1); complete('异常退出回收与 interrupted 无自动重放', { stoppedOwnedDescendants: allOwned.length, interruptedTaskRetained: true, previousArtifactsRetained: artifacts.length, automaticReplay: false });
      const preserved = { projects, asset, artifacts, sourceHash: await hash(entry), metadataHashes: await Promise.all(projects.map(async project => ({ id: project.id, sha256: await hash(path.join(project.path, 'project.json')) }))) };
      await quit();
      writeJson(checkpointFile, { schema: 1, phase1Passed: true, v1Version: options.toolVersion, profileFile, dataRoot, workspaceRoot, catalog: published.evidence, installedPath: installed.installPath, preserved, completedAt: new Date().toISOString() });
      complete('第一阶段 checkpoint 与正常退出');
    } else {
      const checkpoint = readJson(checkpointFile); assert.notEqual(checkpoint.v1Version, options.toolVersion); const oldTool = initial.tools.find(tool => tool.id === 'hyperframes'); assert.equal(oldTool.installedVersion, checkpoint.v1Version);
      for (const artifact of checkpoint.preserved.artifacts) assert.equal(await hash(artifact.path), artifact.sha256);
      const tools = await call('tools.list', { refresh: true }); assert.equal(tools.find(tool => tool.id === 'hyperframes').availableVersion, options.toolVersion); const update = await call('tools.install', { toolId: 'hyperframes' }); await task(update.id, '真实 signed catalog 组件升级'); await locateDownloadedPackage(dataRoot, published.tool.package);
      const installed = (await call('platform.snapshot')).tools.find(tool => tool.id === 'hyperframes'); const runtime = await validateRuntime(installed); assert.notEqual(installed.installPath, checkpoint.installedPath); complete('真实组件版本升级与健康回读', { fromVersion: checkpoint.v1Version, toVersion: installed.installedVersion, packageSha256: published.tool.package.sha256 });
      const snapshot = await call('platform.snapshot'); const projects = checkpoint.preserved.projects;
      for (const project of projects) { assert.ok(snapshot.projects.some(item => item.id === project.id)); await invoke('preview', project); const lint = await invoke('lint', project); assert.equal(lint.result.ok, true); await browserCheck(project); }
      const rendered = await invoke('render', projects[0], {}, { onUpdate: () => evidence() }); const freshArtifact = await media(rendered, projects[0], runtime); complete('旧工程在新版重开并再次真实导出', freshArtifact.media);
      const beforeStop = (await evidence()).processes.filter(process => process.path && within(componentRoot, process.path));
      await stopPreview(projects[0]); await noProcesses(beforeStop);
      const before = await call('platform.snapshot'); const retainedArtifacts = before.artifacts.filter(artifact => projects.some(project => project.id === artifact.projectId)); const hashes = await Promise.all(retainedArtifacts.map(async artifact => ({ id: artifact.id, path: artifact.path, sha256: await hash(artifact.path) })));
      const removed = await call('tools.uninstall', { toolId: 'hyperframes' }); assert.equal(removed.uninstalled, true); assert.equal(removed.dataPreserved, true); const after = await call('platform.snapshot'); assert.equal(after.tools.find(tool => tool.id === 'hyperframes').status, 'not-installed'); assert.equal(fs.existsSync(path.join(dataRoot, 'components', 'hyperframes')), false);
      for (const project of projects) { assert.ok(after.projects.some(item => item.id === project.id)); assert.equal(await hash(path.join(project.path, 'project.json')), checkpoint.preserved.metadataHashes.find(item => item.id === project.id).sha256); }
      const asset = after.assets.find(item => item.id === checkpoint.preserved.asset.id); assert.ok(asset); assert.equal(await hash(asset.path), checkpoint.preserved.asset.sha256);
      for (const artifact of hashes) { assert.ok(after.artifacts.some(item => item.id === artifact.id)); assert.equal(await hash(artifact.path), artifact.sha256); } assert.equal(await hash(path.join(projects[0].path, 'index.html')), checkpoint.preserved.sourceHash);
      assert.ok(after.tools.filter(tool => tool.id !== 'hyperframes').every(tool => tool.status === 'not-installed')); complete('卸载组件保留工程、素材和全部成果', { projects: projects.length, sharedAssets: 1, artifacts: hashes.length, originalToolsTouched: false });
      await quit(); complete('第二阶段正常退出');
    }
    report.passed = true; report.completedAt = new Date().toISOString(); save(); console.log(`Component acceptance ${options.phase} passed. Public summary remains under work/component-acceptance.`); return report;
  } catch (error) { report.error = { message: error.message, stack: error.stack }; report.completedAt = new Date().toISOString(); save(); if (activeApp && activeApp.child.exitCode === null) { try { await quit('cancel'); } catch { activeApp?.child.kill('SIGKILL'); } } throw error; }
}

module.exports = { optionsFor, within, renderTree, changeDuration, summaryFor, main };
if (require.main === module) main().catch(error => { console.error(safeError(error.message)); process.exitCode = 1; });
