'use strict';
// Runs only when explicitly invoked after installer acceptance has finished.
// Reuses the completed component acceptance profile and its real verified ZIP.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { verifyEnvelope } = require('../desktop/core/catalog.cjs');
const { exeVersion } = require('./accept-upgrade.cjs');

const ROOT = path.resolve(__dirname, '..');
const BASE = path.join(ROOT, 'work', 'component-acceptance');
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function within(root, value) { const rel = path.relative(path.resolve(root), path.resolve(value)); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
async function sha256(file) { const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
function optionsFor(argv) {
  const result = { runId: 'github-hf-01', version: '0.1.0-preview.2', playwrightModule: process.env.MEDIAHUB_PLAYWRIGHT_MODULE || 'playwright', keepComponent: false };
  const fields = { '--app-exe': 'appExe', '--run-id': 'runId', '--expected-version': 'version', '--expected-platform-version': 'platformVersion', '--playwright-module': 'playwrightModule' };
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--help') return { help: true }; if (argv[i] === '--keep-component') { result.keepComponent = true; continue; } const name = fields[argv[i]]; assert.ok(name && argv[i + 1] && !argv[i + 1].startsWith('--'), `Invalid option: ${argv[i]}`); result[name] = argv[++i]; }
  assert.ok(result.appExe, 'Required: --app-exe'); result.appExe = path.resolve(result.appExe);
  assert.match(result.runId, /^[a-zA-Z0-9-]{1,60}$/); assert.match(result.version, /^\d+\.\d+\.\d+-preview\.\d+$/);
  result.platformVersion ||= result.version; assert.match(result.platformVersion, /^\d+\.\d+\.\d+-preview\.\d+$/);
  assert.ok(within(path.join(ROOT, 'release'), result.appExe) || within(path.join(ROOT, 'work'), result.appExe), 'Use an actual packaged acceptance app under release or work'); assert.equal(path.basename(result.appExe).toLowerCase(), 'mediahub.exe');
  return result;
}
function program(executable, args, { input = '', timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); let output = '', errorOutput = '', settled = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error(`${path.basename(executable)} timed out`)); }, timeout);
    function finish(error, value) { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); }
    child.once('error', error => finish(error)); child.stdout.on('data', data => { output += data.toString('utf8'); if (Buffer.byteLength(output) > 2 * 1024 * 1024) { child.kill(); finish(new Error('Native response exceeds 2 MiB')); } }); child.stderr.on('data', data => { if (errorOutput.length < 16000) errorOutput += data.toString('utf8'); });
    child.once('close', code => code === 0 ? finish(null, output) : finish(new Error(`${path.basename(executable)} exited ${code}: ${errorOutput.slice(0, 1200)}`))); child.stdin.end(input);
  });
}
async function powershell(script, value = {}) {
  const prefix = '$ErrorActionPreference="Stop";[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$inputRecord=[Console]::In.ReadToEnd()|ConvertFrom-Json;';
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return JSON.parse((await program(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(prefix + script, 'utf16le').toString('base64')], { input: JSON.stringify(value), timeout: 45000 })).trim().replace(/^\uFEFF/, ''));
}
async function noRunningPlatform() { const pids = await powershell('ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter "Name=\'MediaHub.exe\'"|ForEach-Object{$_.ProcessId}) -Compress'); assert.equal(pids.length, 0, 'Another MediaHub is running; wait until installer or component acceptance has finished'); }
async function unusedPort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
function sanitize(message, secrets = []) {
  let text = String(message || ''); for (const secret of secrets) if (secret) text = text.replaceAll(secret, '<credential>');
  return text.replace(/(?:token=|mh_hf=)[^&\s"'<>]+/gi, '<credential>').replace(/\b[a-f0-9]{64}\b/gi, '<digest>').replace(/[A-Za-z]:[\\/][^\n\r"'<>)]*/g, '<local-path>');
}
function publicReport(value) {
  return { schema: 1, passed: value.passed, startedAt: value.startedAt, completedAt: value.completedAt, platformVersion: value.platformVersion, toolVersion: value.toolVersion, profile: 'existing-isolated-component-acceptance', installation: value.installation && { reusedVerifiedGithubDownloadCache: value.installation.reusedVerifiedGithubDownloadCache, freshDownloadClaimed: false, packageSha256: value.installation.packageSha256, packageBytes: value.installation.packageBytes }, cdp: value.cdp && { binding: value.cdp.binding, ownProcessVerified: value.cdp.ownProcessVerified, onlyLoopbackListeners: value.cdp.onlyLoopbackListeners }, tests: value.tests.map(test => ({ name: test.name, passed: test.passed, metrics: test.metrics })), screenshots: value.screenshots.map(item => ({ name: item.name, sha256: item.sha256 })), pageErrors: value.pageErrors.map(item => sanitize(item)), consoleErrors: value.consoleErrors.map(item => sanitize(item)), error: value.error ? { message: sanitize(value.error.message) } : undefined };
}

async function main(argv = process.argv.slice(2)) {
  const options = optionsFor(argv);
  if (options.help) { console.log('Usage: node scripts/accept-studio.cjs --app-exe release/win-unpacked/MediaHub.exe [--run-id github-hf-01] [--expected-version <component .2>] [--expected-platform-version <platform .3>] [--playwright-module <existing Playwright package>] [--keep-component]\nRequires completed real v1/v2 component acceptance and its verified GitHub cache. Starts only its own loopback-CDP app, modifies and restores only the isolated test composition, then normally stops/uninstalls the component and quits. Never run concurrently with installer acceptance.'); return; }
  assert.equal(process.platform, 'win32'); await noRunningPlatform();
  const { chromium } = require(options.playwrightModule);
  const profileRoot = path.join(BASE, options.runId); assert.ok(within(fs.realpathSync(BASE), fs.realpathSync(profileRoot)));
  const profileFile = path.join(profileRoot, 'profile.json'); const profile = readJson(profileFile); const checkpoint = readJson(path.join(profileRoot, 'checkpoint.json')); const upgradeReport = readJson(path.join(profileRoot, 'upgrade-v2.public.json'));
  assert.equal(profile.acceptance, true); assert.equal(checkpoint.phase1Passed, true); assert.equal(upgradeReport.passed, true); assert.equal(upgradeReport.toolVersion, options.version);
  assert.equal(path.resolve(profile.dataRoot).toLowerCase(), path.join(profileRoot, 'data').toLowerCase()); assert.equal(path.resolve(profile.workspaceRoot).toLowerCase(), path.join(profileRoot, '共享 项目与素材').toLowerCase());
  const appDir = path.dirname(fs.realpathSync(options.appExe)); const pe = await exeVersion(options.appExe); assert.equal(pe.productName, 'MediaHub'); assert.equal(pe.fileVersion, options.platformVersion);
  const signed = readJson(path.join(profile.dataRoot, 'catalog.signed.json')); const catalog = verifyEnvelope(signed, fs.readFileSync(path.join(appDir, 'resources/resources/catalog-public.pem'), 'utf8')); const descriptor = catalog.tools.find(t => t.id === 'hyperframes'); assert.equal(descriptor.version, options.version);
  assert.ok(descriptor.package.url.startsWith('https://github.com/jerryrenjianxing-sys/MediaHub/releases/download/'));
  const cached = path.join(profile.dataRoot, 'downloads', `hyperframes-${options.version}-${descriptor.package.sha256.slice(0, 12)}.zip`); assert.equal(fs.statSync(cached).size, descriptor.package.bytes); assert.equal(await sha256(cached), descriptor.package.sha256);
  const project = checkpoint.preserved.projects.find(p => p.orientation === 'landscape'); assert.ok(project && within(profile.workspaceRoot, project.path)); assert.ok(within(fs.realpathSync(profile.workspaceRoot), fs.realpathSync(project.path)));
  const entry = path.join(project.path, 'index.html'); const originalSource = fs.readFileSync(entry, 'utf8'); const originalHash = await sha256(entry); const priorArtifacts = [], priorMetadata = [];
  for (const existingProject of checkpoint.preserved.projects) { assert.ok(within(profile.workspaceRoot, existingProject.path)); priorMetadata.push({ file: path.join(existingProject.path, 'project.json'), sha256: await sha256(path.join(existingProject.path, 'project.json')) }); for (const artifact of readJson(path.join(existingProject.path, 'artifacts.json'))) { assert.ok(within(existingProject.path, artifact.path)); priorArtifacts.push({ id: artifact.id, path: artifact.path, sha256: await sha256(artifact.path) }); } }
  const preservedAsset = checkpoint.preserved.asset; assert.ok(within(profile.workspaceRoot, preservedAsset.path)); assert.equal(await sha256(preservedAsset.path), preservedAsset.sha256);
  const out = path.join(profileRoot, 'studio-acceptance', `run-${Date.now()}`); fs.mkdirSync(out, { recursive: true });
  const report = { passed: false, startedAt: new Date().toISOString(), completedAt: null, platformVersion: pe.fileVersion, toolVersion: options.version, installation: null, cdp: null, tests: [], screenshots: [], pageErrors: [], consoleErrors: [] };
  const secrets = []; const save = () => { const safe = publicReport(report); writeJson(path.join(out, 'report.public.json'), safe); writeJson(path.join(profileRoot, 'studio.public.json'), safe); };
  function pass(name, metrics = {}) { report.tests.push({ name, passed: true, metrics }); save(); console.log(`PASS ${name}`); }
  let child, browser, platformPage, studioPage; let active = false, modified = false, capturedOutput = '';
  async function call(method, params = {}, timeout = 180000) {
    const connection = readJson(path.join(profile.dataRoot, 'connection.json')); assert.equal(connection.protocol, 1); assert.equal(connection.pid, child.pid); assert.equal(connection.acceptance, true); assert.match(connection.pipe, /^[a-zA-Z0-9_.-]{1,160}$/); assert.ok(within(appDir, fs.realpathSync(connection.clientPath)));
    const id = crypto.randomUUID(); const receipt = JSON.parse(await program(connection.clientPath, ['client', '--pipe', connection.pipe], { input: JSON.stringify({ protocol: 1, id, method, params }) + '\n', timeout })); assert.equal(receipt.id, id); if (!receipt.ok) throw Error(receipt.error?.message || 'Native operation failed'); return receipt.result;
  }
  async function waitTask(id) { const deadline = Date.now() + 20 * 60000; while (Date.now() < deadline) { const value = await call('tasks.get', { taskId: id }); if (TERMINAL.has(value.state)) { assert.equal(value.state, 'completed', value.error?.message || 'Tool operation failed'); return value; } await pause(500); } throw Error('Tool operation timeout; outcome must be checked before retry'); }
  function captureErrors(page) { page.on('pageerror', error => report.pageErrors.push(sanitize(error.message, secrets))); page.on('console', item => { if (item.type() === 'error') report.consoleErrors.push(sanitize(item.text(), secrets)); }); }
  async function screenshot(page, name) { const file = path.join(out, name); await page.screenshot({ path: file }); report.screenshots.push({ name, sha256: await sha256(file) }); save(); }
  async function studioFrame() { const deadline = Date.now() + 30000; while (Date.now() < deadline) { const frame = studioPage.frames().find(frame => { try { const url = new URL(frame.url()); return url.hostname === '127.0.0.1' && url.pathname === `/p/${project.id}/preview`; } catch { return false; } }); if (frame) { await frame.waitForFunction(() => window.__playerReady === true && !!window.__player, { timeout: 15000 }); return frame; } await pause(100); } throw Error('Real generated cross-origin frame did not initialize'); }
  async function quit() { if (!active) return; await call('platform.quit', { mode: 'wait' }, 30000).catch(error => { if (!/pipe|connection|closed|exit|response/i.test(error.message)) throw error; }); const deadline = Date.now() + 90000; while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await pause(100); assert.ok(child.exitCode !== null || child.signalCode !== null, 'Owned app did not exit'); active = false; }
  try {
    save(); await noRunningPlatform(); const port = await unusedPort(); const env = { ...process.env, PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') }; delete env.ELECTRON_RUN_AS_NODE; delete env.MEDIAHUB_PROFILE;
    child = spawn(options.appExe, ['--mediahub-profile', profileFile, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { cwd: appDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); active = true; let spawnError; child.on('error', error => { spawnError = error; });
    // Keep raw diagnostics in memory, then sanitize the complete stream so split
    // credential/path fragments cannot escape redaction across chunk boundaries.
    const capture = data => { if (capturedOutput.length < 500000) capturedOutput += data.toString('utf8'); }; child.stdout.on('data', capture); child.stderr.on('data', capture);
    const deadline = Date.now() + 90000; let debug;
    while (Date.now() < deadline) { if (spawnError) throw spawnError; if (child.exitCode !== null) throw Error('Owned app exited before debugging became ready'); try { const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) }); if (response.ok) { debug = await response.json(); break; } } catch {} await pause(200); }
    assert.ok(debug?.webSocketDebuggerUrl, 'Own CDP endpoint did not become ready'); assert.equal(new URL(debug.webSocketDebuggerUrl).hostname, '127.0.0.1');
    const listeners = await powershell('ConvertTo-Json -InputObject @(Get-NetTCPConnection -State Listen -LocalPort ([int]$inputRecord.port)|ForEach-Object{@{address=$_.LocalAddress;pid=[int]$_.OwningProcess}}) -Compress', { port });
    assert.ok(listeners.length > 0); assert.ok(listeners.every(item => ['127.0.0.1', '::1'].includes(item.address) && item.pid === child.pid), 'CDP listener is not owned and bound only to loopback'); report.cdp = { binding: '127.0.0.1', ownProcessVerified: true, onlyLoopbackListeners: true }; pass('独立 CDP 确认仅绑定 loopback');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const pages = () => browser.contexts().flatMap(context => context.pages());
    platformPage = pages().find(page => page.url().startsWith('mediahub://app/')); assert.ok(platformPage); captureErrors(platformPage);
    await platformPage.waitForFunction(() => !!window.mediaHub);
    assert.deepEqual(await platformPage.evaluate(() => ({ bridge: typeof window.mediaHub.openStudio, require: typeof window.require, process: typeof window.process })), { bridge: 'function', require: 'undefined', process: 'undefined' }); let snapshot;
    for (let attempt = 0; attempt < 100; attempt++) { snapshot = await call('platform.snapshot'); if (snapshot.connection.available) break; await pause(100); }
    assert.equal(snapshot.version, options.platformVersion); assert.equal(snapshot.connection.profile, 'acceptance'); assert.equal(path.resolve(snapshot.workspace.path).toLowerCase(), path.resolve(profile.workspaceRoot).toLowerCase()); assert.ok(snapshot.projects.some(p => p.id === project.id));
    const tool = snapshot.tools.find(tool => tool.id === 'hyperframes'); assert.equal(tool.status, 'not-installed', 'This UI acceptance begins after the real component uninstall');
    const install = await call('tools.install', { toolId: 'hyperframes' }); await waitTask(install.id); snapshot = await call('platform.snapshot'); assert.equal(snapshot.tools.find(tool => tool.id === 'hyperframes').installedVersion, options.version);
    report.installation = { reusedVerifiedGithubDownloadCache: true, freshDownloadClaimed: false, packageSha256: descriptor.package.sha256, packageBytes: descriptor.package.bytes }; pass('复用先前真实 GitHub 校验缓存安装', { freshDownloadClaimed: false });
    await platformPage.getByRole('button', { name: '项目', exact: true }).click(); await platformPage.getByRole('button').filter({ hasText: project.name }).first().click();
    // The real React button invokes the finite preload openStudio(projectId,bounds).
    await platformPage.getByRole('button', { name: '打开 Studio', exact: true }).click(); await platformPage.locator('.studio-surface').waitFor();
    const studioDeadline = Date.now() + 90000;
    while (Date.now() < studioDeadline) { studioPage = pages().find(page => { try { return new URL(page.url()).hostname === 'localhost'; } catch { return false; } }); if (studioPage && await studioPage.locator('#preview').count()) break; await pause(100); }
    assert.ok(studioPage, 'Native Studio page was not created'); captureErrors(studioPage);
    const logSession = await studioPage.context().newCDPSession(studioPage); logSession.on('Log.entryAdded', event => { if (event.entry.level === 'error') report.consoleErrors.push(sanitize(event.entry.text, secrets)); }); await logSession.send('Log.enable');
    assert.equal(await studioPage.title(), 'MediaHub · HyperFrames Studio'); await studioPage.locator('#preview').waitFor({ state: 'visible' }); let frame = await studioFrame();
    const windowState = await call('acceptance.window', { action: 'show' }); assert.equal(windowState.studioAttached, true);
    const bounds = await platformPage.locator('.studio-surface').boundingBox(); const actualSize = await studioPage.evaluate(() => ({ width: innerWidth, height: innerHeight })); assert.ok(Math.abs(actualSize.width - Math.round(bounds.width)) <= 3 && Math.abs(actualSize.height - Math.round(bounds.height)) <= 3, 'Actual native Studio bounds differ from the trusted UI surface');
    const iframe = await studioPage.locator('#preview').evaluate(el => ({ sandbox: el.getAttribute('sandbox'), referrerPolicy: el.referrerPolicy, url: el.src })); const previewUrl = new URL(iframe.url); assert.equal(previewUrl.hostname, '127.0.0.1'); assert.notEqual(previewUrl.origin, new URL(studioPage.url()).origin); assert.equal(iframe.referrerPolicy, 'no-referrer'); assert.equal(iframe.sandbox, 'allow-scripts allow-same-origin'); pass('真实 WebContentsView、localhost Studio 与跨来源生成 iframe', { attached: true, nativeBoundsMatch: true, width: actualSize.width, height: actualSize.height, crossOrigin: true });
    const studioOrigin = new URL(studioPage.url()).origin; const cookieState = await logSession.send('Network.getCookies', { urls: [studioOrigin] }); const cookie = cookieState.cookies.find(item => item.name === 'mh_hf'); assert.ok(cookie && cookie.httpOnly && cookie.sameSite === 'Strict'); secrets.push(cookie.value);
    const topSession = await platformPage.context().newCDPSession(platformPage); const platformCookies = await topSession.send('Network.getCookies', { urls: [studioOrigin] }); assert.ok(!platformCookies.cookies.some(item => item.name === 'mh_hf'));
    const studioIsolation = await studioPage.evaluate(secret => ({ mediaHub: typeof window.mediaHub, require: typeof window.require, process: typeof window.process, cookieReadable: document.cookie.includes('mh_hf'), tokenInDom: document.documentElement.outerHTML.includes(secret), tokenInUrl: location.href.includes(secret) }), cookie.value);
    const generatedIsolation = await frame.evaluate(secret => { const probe = getter => { try { return { blocked: false, type: typeof getter() }; } catch (e) { return { blocked: e.name === 'SecurityError' }; } }; return { mediaHub: typeof window.mediaHub, require: typeof window.require, process: typeof window.process, parentMediaHub: probe(() => parent.mediaHub), parentCookie: probe(() => parent.document.cookie), parentLocation: probe(() => parent.location.href), topMediaHub: probe(() => top.mediaHub), cookieReadable: document.cookie.includes('mh_hf'), tokenInDom: document.documentElement.outerHTML.includes(secret), tokenInUrl: location.href.includes(secret), referrerEmpty: document.referrer === '' }; }, cookie.value);
    for (const scope of [studioIsolation, generatedIsolation]) { assert.equal(scope.mediaHub, 'undefined'); assert.equal(scope.require, 'undefined'); assert.equal(scope.process, 'undefined'); assert.equal(scope.cookieReadable, false); assert.equal(scope.tokenInDom, false); assert.equal(scope.tokenInUrl, false); }
    for (const field of ['parentMediaHub', 'parentCookie', 'parentLocation', 'topMediaHub']) assert.equal(generatedIsolation[field].blocked, true); assert.equal(generatedIsolation.referrerEmpty, true);
    const anonymous = await fetch(`${studioOrigin}/mediahub/projects`, { signal: AbortSignal.timeout(10000) }); assert.equal(anonymous.status, 401);
    snapshot = await call('platform.snapshot'); assert.ok(snapshot.tasks.filter(task => task.createdAt >= report.startedAt).every(task => !task.result?.studioUrl && !JSON.stringify(task.result).includes(cookie.value))); pass('来源、会话与 HttpOnly 凭据隔离', { studioPreloadAbsent: true, generatedPreloadAbsent: true, rendererNodeAbsent: true, parentAccessBlocked: true, tokenNotExposedToDom: true, tokenNotExposedInPublicReceipts: true, platformSessionHasNoStudioCookie: true, unauthenticatedStudioStatus: anonymous.status });
    await studioPage.locator('#restart').click(); await frame.waitForFunction(() => Math.abs(window.__player.getTime()) < .05); const beforePlay = await frame.evaluate(() => window.__player.getTime()); await studioPage.locator('#play').click(); await pause(350); const afterPlay = await frame.evaluate(() => window.__player.getTime()); assert.ok(afterPlay > beforePlay + .15, 'Generated runtime did not actually advance during Studio playback');
    if (await studioPage.locator('#play').textContent() === '暂停') await studioPage.locator('#play').click(); const paused = await frame.evaluate(() => window.__player.getTime()); await pause(200); assert.ok(Math.abs(await frame.evaluate(() => window.__player.getTime()) - paused) < .05, 'Generated player did not pause');
    await studioPage.locator('#seek').evaluate(el => { el.value = '.8'; el.dispatchEvent(new Event('input', { bubbles: true })); }); await frame.waitForFunction(() => Math.abs(window.__player.getTime() - .8) < .05); pass('Studio 播放、暂停与时间轴驱动真实生成播放器', { actualPlayTimeAdvanced: true, actualPauseConfirmed: true, seekMatched: true });
    await studioPage.locator('#edit').click(); await studioPage.locator('#source').waitFor({ state: 'visible' }); await screenshot(studioPage, 'studio-before-agent-edit.png');
    const marker = 'Studio 自动刷新 中文验收'; const changed = originalSource.replace(/(<h1 class="title">)[\s\S]*?(<\/h1>)/, `$1${marker}$2`); assert.notEqual(changed, originalSource); fs.writeFileSync(entry, changed); modified = true;
    await studioPage.waitForFunction(value => document.getElementById('source').value.includes(value), marker, { timeout: 30000 }); frame = await studioFrame(); await frame.waitForFunction(value => document.querySelector('h1.title')?.textContent === value, marker, { timeout: 30000 });
    await studioPage.locator('#seek').evaluate(el => { el.value = '.8'; el.dispatchEvent(new Event('input', { bubbles: true })); }); await frame.waitForFunction(() => Math.abs(window.__player.getTime() - .8) < .05); await screenshot(studioPage, 'studio-after-agent-edit.png'); pass('Agent 修改实际源码后 SSE 自动刷新编辑器与 iframe', { sourceUpdated: true, generatedFrameUpdated: true, explicitReloadRequired: false });
    fs.writeFileSync(entry, originalSource); modified = false; await studioPage.waitForFunction(value => !document.getElementById('source').value.includes(value), marker, { timeout: 30000 }); assert.equal(await sha256(entry), originalHash);
    await platformPage.getByRole('button', { name: '返回项目', exact: true }).click(); const closeDeadline = Date.now() + 20000; let detached = false;
    while (Date.now() < closeDeadline) { const state = await call('acceptance.window', { action: 'show' }); if (!state.studioAttached && studioPage.isClosed()) { detached = true; break; } await pause(100); } assert.equal(detached, true, 'Closing Studio did not remove and close its native WebContentsView'); pass('返回项目确实移除并关闭 WebContentsView');
    await platformPage.getByRole('button', { name: '连接 Agent', exact: true }).click(); await screenshot(platformPage, 'platform-after-studio-close.png');
    const stop = await call('capabilities.invoke', { capabilityId: 'hyperframes.stop', projectId: project.id, options: {} }); await waitTask(stop.id);
    if (!options.keepComponent) { const removed = await call('tools.uninstall', { toolId: 'hyperframes' }); assert.equal(removed.uninstalled, true); assert.equal(removed.dataPreserved, true); assert.equal(fs.existsSync(path.join(profile.dataRoot, 'components/hyperframes')), false); }
    const retained = await call('platform.snapshot'); for (const artifact of priorArtifacts) { assert.ok(retained.artifacts.some(item => item.id === artifact.id)); assert.equal(await sha256(artifact.path), artifact.sha256); } for (const metadata of priorMetadata) assert.equal(await sha256(metadata.file), metadata.sha256); assert.equal(await sha256(preservedAsset.path), preservedAsset.sha256); assert.ok(retained.assets.some(item => item.id === preservedAsset.id)); assert.equal(await sha256(entry), originalHash); assert.ok(retained.projects.some(item => item.id === project.id)); pass('恢复验收源码、停止组件并保留既有工程和成果', { originalSourceRestored: true, retainedProjects: priorMetadata.length, retainedSharedAssets: 1, retainedArtifacts: priorArtifacts.length, componentUninstalled: !options.keepComponent });
    assert.deepEqual(report.pageErrors, [], 'Renderer emitted actual page errors'); assert.deepEqual([...new Set(report.consoleErrors)], [], 'Renderer emitted actual console/CSP errors'); await quit(); await browser.close().catch(() => {}); await noRunningPlatform(); pass('无页面错误并正常退出所属平台');
    report.passed = true; report.completedAt = new Date().toISOString(); save(); console.log('Actual embedded Studio acceptance passed. Public report remains in the isolated component profile.'); return report;
  } catch (error) {
    if (studioPage && !studioPage.isClosed()) await screenshot(studioPage, 'studio-failure.png').catch(() => {}); report.error = { message: sanitize(error.message, secrets) }; report.completedAt = new Date().toISOString(); save(); throw error;
  } finally {
    if (modified) { fs.writeFileSync(entry, originalSource); assert.equal(await sha256(entry), originalHash); }
    if (active) { await platformPage?.evaluate(() => window.mediaHub.closeStudio()).catch(() => {}); try { await quit(); } catch { child?.kill('SIGKILL'); } }
    await browser?.close().catch(() => {}); fs.writeFileSync(path.join(out, 'app-output.sanitized.log'), sanitize(capturedOutput, secrets));
  }
}

module.exports = { optionsFor, within, sanitize, publicReport, main };
if (require.main === module) main().catch(error => { console.error(sanitize(error.message)); process.exitCode = 1; });
