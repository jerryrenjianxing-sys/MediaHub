'use strict';
const { app, BrowserWindow, WebContentsView, Menu, Tray, nativeImage, ipcMain, dialog, shell, clipboard, protocol, net, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createManager } = require('./core/manager.cjs');
const { HyperframesClient } = require('./hyperframes-client.cjs');
const { UpdateController } = require('./updates.cjs');
const { verifyExternal, scanExternal, powershellJson } = require('./external-tools.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'mediahub', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const sourceRoot = path.resolve(__dirname, '..');
const resourceRoot = app.isPackaged ? process.resourcesPath : sourceRoot;
const profileArgument = process.argv.indexOf('--mediahub-profile');
const profilePath = profileArgument >= 0 ? process.argv[profileArgument + 1] : process.env.MEDIAHUB_PROFILE;
let profile = null;
if (profilePath) {
  profile = JSON.parse(fs.readFileSync(path.resolve(profilePath), 'utf8').replace(/^\uFEFF/, ''));
  if (profile.acceptance !== true || !path.isAbsolute(profile.dataRoot)) throw new Error('验收配置必须声明 acceptance:true 和独立的绝对 dataRoot');
}
const dataRoot = profile ? path.resolve(profile.dataRoot) : path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'MediaHub');
app.setPath('userData', path.join(dataRoot, 'desktop'));
app.setAppUserModelId('com.mediahub.desktop');
const userSid = execFileSync(path.join(process.env.SystemRoot, 'System32/whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).match(/S-1-5-(?:\d+-)*\d+/)?.[0];
if (!userSid) throw new Error('无法确认当前 Windows 用户身份');
const pipeName = `MediaHub-${crypto.createHash('sha256').update(`${userSid}|${dataRoot.toLowerCase()}`).digest('hex').slice(0, 24)}`;
const helperPath = app.isPackaged ? path.join(resourceRoot, 'native/mediahub-pipe.exe') : path.join(sourceRoot, 'build/native/mediahub-pipe.exe');
let manager, window, tray, studio, pipeServer, updates, quitting = false, quitWait = false, ready = false, studioGeneration = 0, pipeReady = false, updateInstallScheduled = false;
const externalTasks = new Map();
const studioUrls = new Map();
fs.mkdirSync(path.join(dataRoot, 'logs'), { recursive: true });
function log(kind, value) { fs.appendFileSync(path.join(dataRoot, 'logs/desktop.log'), `${new Date().toISOString()} ${kind} ${String(value).slice(0, 8000)}\n`); }
const hf = new HyperframesClient({ helperPath, log });

function snapshot() { return { ...manager.snapshot(), platformUpdates: updates?.snapshot() || { status: 'unavailable', currentVersion: app.getVersion(), error: '开发模式未启用平台升级' }, connection: { ...(manager.snapshot().connection || {}), transport: 'windows-named-pipe', pipe: pipeName, pipeName, endpoint: `\\\\.\\pipe\\${pipeName}`, skillPath: path.join(resourceRoot, 'agent-skill/mediahub'), available: pipeReady, profile: profile ? 'acceptance' : 'production' } }; }
function changed() { if (ready && pipeReady) updates?.markReady(); if (window && !window.isDestroyed() && ready) window.webContents.send('mediahub:changed', snapshot()); maybeFinishQuit(); }
function busyTasks() { return manager?.snapshot().tasks.filter(t => ['queued', 'running', 'cancelling'].includes(t.state)) || []; }
function busyOperations() { return manager?.snapshot().operations?.filter(o => ['queued', 'running', 'downloading', 'installing', 'verifying', 'starting'].includes(o.state || o.status)) || []; }
function hasWork() { return busyTasks().length > 0 || busyOperations().length > 0 || hf.busy; }
function safeHttps(url) { const parsed = new URL(url); if (parsed.protocol !== 'https:') throw new Error('仅支持 HTTPS 下载入口'); return parsed.href; }
function knownTool(id) { const value = manager.snapshot().tools.find(t => t.id === id); if (!value) throw new Error('工具不存在'); return value; }
function activeHyperframesRoot() {
  const tool = knownTool('hyperframes');
  const root = tool.installPath || tool.path;
  if (!root || !['installed', 'running', 'ready'].includes(tool.status)) throw new Error('请先安装 HyperFrames 工具包');
  const resolved = fs.realpathSync(root);
  const components = path.resolve(dataRoot, 'components');
  if (!resolved.toLowerCase().startsWith(components.toLowerCase() + path.sep)) throw new Error('组件路径不在受管目录中');
  return resolved;
}
function runFile(executable, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '', stderr = '';
    child.stdout?.on('data', data => { stdout += data; if (stdout.length > 1024 * 1024) child.kill(); });
    child.stderr?.on('data', data => { stderr += data; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.slice(0, 2000) || `程序退出码 ${code}`)));
  });
}
async function openExternalTool(tool, installed = {}, { action: intent = 'open' } = {}) {
  const executable = installed.installPath || tool.installPath || tool.executable;
  if (executable && /\.exe$/i.test(executable) && fs.existsSync(executable)) {
    const error = await shell.openPath(executable); if (error) throw new Error(error);
    return { opened: true, management: 'original', message: intent === 'uninstall' ? '已打开原软件；请在原软件或 Windows 已安装应用中卸载。' : '已打开原软件，由原软件管理更新与业务数据。' };
  }
  if (tool.links?.update || tool.entryUrl) { await shell.openExternal(safeHttps(tool.links?.update || tool.entryUrl)); return { opened: true, management: 'original', message: '已打开原发行入口，操作由原软件完成。' }; }
  throw new Error('尚未识别到原软件入口');
}
async function installExternalTool(tool, context = {}) {
  const { downloadVerified } = require('./core/packages.cjs');
  if (!tool.install?.sha256) throw new Error('此工具尚未提供可信下载校验');
  const installer = await downloadVerified(tool.install, path.join(dataRoot, 'downloads', tool.install.fileName), context);
  context.signal?.throwIfAborted();
  // Original installers own their paths/accounts. Never pass destructive or profile-migration flags.
  const child = spawn(installer, [], { windowsHide: false, stdio: 'ignore' });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve({ code })); });
  if (result.code !== 0) throw new Error(`原软件安装器退出码 ${result.code}；尚未确认安装成功`);
  const discovered = await scanExternal(tool);
  if (!discovered) throw new Error('原安装器已退出，但未识别到实际安装；请完成原软件安装后重新识别');
  return { ...discovered, installerExited: true, code: result.code };
}
async function archiveSkill({ skillPath }) {
  const target = path.join(dataRoot, 'downloads', `MediaHub-Skill-${app.getVersion()}-${crypto.randomUUID().slice(0, 8)}.zip`);
  await powershellJson("Compress-Archive -LiteralPath $inputRecord.source -DestinationPath $inputRecord.target -CompressionLevel Optimal;@{path=$inputRecord.target}|ConvertTo-Json -Compress", { source: skillPath, target });
  return { path: target };
}
async function componentHealth(toolId, context) {
  if (toolId !== 'hyperframes') throw new Error('此版本仅支持已内置适配的 HyperFrames 组件');
  const root = context.path;
  const manifest = context.manifest;
  if (!manifest || !Array.isArray(manifest.files)) throw new Error('组件缺少逐文件校验清单');
  for (const file of manifest.files) {
    const target = path.resolve(root, file.path);
    if (!target.startsWith(path.resolve(root) + path.sep) || !fs.statSync(target).isFile()) throw new Error('组件校验清单路径无效');
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
    if (hash.digest('hex') !== file.sha256) throw new Error(`组件文件校验失败：${file.path}`);
    context.signal?.throwIfAborted();
  }
  try {
    const status = await hf.start(root);
    if (status?.healthy === false) throw new Error('HyperFrames 健康检查失败');
    context.signal?.throwIfAborted();
    return status;
  } finally {
    // Health check runs in staging and must release its handles before directory activation.
    await hf.stop({ idleOnly: true });
  }
}
async function invokeHyperframes(action, params, context = {}) {
  await hf.start(activeHyperframesRoot());
  const normalized = { ...params, taskId: context.taskId || params.taskId };
  const project = manager.snapshot().projects.find(p => p.id === params.projectId);
  if (action === 'create') normalized.title = params.title || project?.name;
  if (action === 'render') normalized.source = 'agent';
  if (action === 'import' && params.asset) normalized.assets = [{ assetId: params.asset.id, sourcePath: params.asset.path }];
  const result = await hf.invoke(action, normalized, context);
  if (action === 'preview') { if (result.studioUrl) studioUrls.set(params.projectId, result.studioUrl); const { studioUrl, ...safeResult } = result; return { ...safeResult, studioAvailable: !!studioUrl }; }
  if (action === 'render') {
    return { ...result, artifact: { path: result.outputPath, name: path.basename(result.outputPath || 'render.mp4'), media: result.media, mediaValidated: result.mediaValidated === true, projectId: params.projectId, toolId: 'hyperframes' } };
  }
  return result;
}

async function call(method, params = {}) {
  if (method === 'platform.snapshot') return snapshot();
  if (method === 'platform.updates') { if (!params.action) return updates?.snapshot() || snapshot().platformUpdates; return call(`platform.updates/${params.action}`, {}); }
  if (method === 'platform.diagnostics') return { version: app.getVersion(), profile: profile ? 'acceptance' : 'production', dataRoot, workspace: manager.snapshot().workspace, agentAvailable: !!pipeServer, hyperframesRunning: !!hf.child, busy: hasWork(), logPath: path.join(dataRoot, 'logs/desktop.log') };
  if (method === 'tools.update') return manager.call('tools.updateEntry', params);
  if (method === 'tools.uninstall') return manager.call('tools.uninstallEntry', params);
  if (method === 'tools.import' && !params.toolId && !params.path) return manager.call('tools.rescan', {});
  if (method.startsWith('platform.updates/')) {
    if (!updates) throw new Error('当前开发运行不支持平台安装更新');
    if (method === 'platform.updates/install') {
      if (updateInstallScheduled) throw new Error('平台更新已受理，请等待重启');
      if (updates.snapshot().status !== 'downloaded') throw new Error('平台更新尚未下载完成');
      if (hasWork() || studio) throw new Error('请关闭视频编辑页并等待当前任务完成后安装平台更新');
      updateInstallScheduled = true;
      // Return the acceptance receipt before restarting the process and closing its pipe.
      setTimeout(() => updates.call('install').catch(error => { updateInstallScheduled = false; log('update-install', error.message); }), 150);
      return { accepted: true, targetVersion: updates.snapshot().availableVersion, status: 'scheduled' };
    }
    return updates.call(method.slice('platform.updates/'.length));
  }
  if (method === 'agent.connection') return snapshot().connection;
  if (method === 'platform.quit') { if (params.mode && !['wait', 'cancel'].includes(params.mode)) throw new Error('退出方式无效'); await requestQuit(params.mode); return { accepted: true }; }
  if (profile && method === 'acceptance.window') {
    if (params.action === 'close') window.close();
    if (params.action === 'show') window.show();
    return { visible: window.isVisible(), destroyed: window.isDestroyed(), bounds: window.getBounds(), scaleFactor: require('electron').screen.getDisplayMatching(window.getBounds()).scaleFactor, studioAttached: !!studio };
  }
  // Every UI and Agent request reaches the same manager; no renderer-owned state changes.
  return manager.call(method, params);
}
function secureSession(targetSession) {
  targetSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  targetSession.setPermissionCheckHandler(() => false);
  targetSession.setDevicePermissionHandler(() => false);
}
function verifySender(event) { return event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url.startsWith('mediahub://app/'); }
function recordById(kind, id) { const collection = { project: 'projects', asset: 'assets', artifact: 'artifacts' }[kind]; const record = manager.snapshot()[collection]?.find(item => item.id === id); if (!record) throw new Error('记录不存在'); if (!path.isAbsolute(record.path)) throw new Error('记录路径无效'); return record; }
function clampBounds(bounds) {
  if (!bounds || Object.values(bounds).some(v => !Number.isFinite(v))) throw new Error('Studio 窗口边界无效');
  const content = window.getContentBounds();
  return { x: Math.max(0, Math.min(content.width, Math.round(bounds.x))), y: Math.max(0, Math.min(content.height, Math.round(bounds.y))), width: Math.max(0, Math.min(content.width - Math.max(0, bounds.x), Math.round(bounds.width))), height: Math.max(0, Math.min(content.height - Math.max(0, bounds.y), Math.round(bounds.height))) };
}
async function closeStudio() { studioGeneration++; if (studio) { window.contentView.removeChildView(studio); studio.webContents.close(); studio = null; } }
async function openStudio(projectId, bounds) {
  await closeStudio();
  const generation = studioGeneration;
  recordById('project', projectId);
  const receipt = await manager.call('capabilities.invoke', { capabilityId: 'hyperframes.preview', projectId });
  for (let attempts = 0; ; attempts++) {
    const task = await manager.call('tasks.get', { taskId: receipt.id });
    if (task.state === 'completed') break;
    if (['failed', 'cancelled', 'interrupted'].includes(task.state)) throw new Error(task.error?.message || 'Studio 预览未能启动');
    if (attempts >= 750) throw new Error('Studio 预览启动超时，请检查任务状态');
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  if (generation !== studioGeneration) return { cancelled: true };
  const target = new URL(studioUrls.get(projectId));
  if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.protocol !== 'http:') throw new Error('Studio 返回了不受信任的地址');
  const studioSession = session.fromPartition(`mediahub-studio-${crypto.randomUUID()}`);
  secureSession(studioSession);
  studio = new WebContentsView({ webPreferences: { session: studioSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false } });
  studio.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const origin = target.origin;
  studio.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
  const allowedOrigins = new Set([origin, new URL((await manager.call('tasks.get', { taskId: receipt.id })).result.previewUrl).origin]);
  studio.webContents.on('will-frame-navigate', details => { try { if (!allowedOrigins.has(new URL(details.url).origin)) details.preventDefault(); } catch { details.preventDefault(); } });
  window.contentView.addChildView(studio); studio.setBounds(clampBounds(bounds));
  const currentStudio = studio;
  try { await currentStudio.webContents.loadURL(target.href); }
  catch (error) { if (generation === studioGeneration) await closeStudio(); throw error; }
  if (generation !== studioGeneration) return { cancelled: true };
  return { ready: true, projectId };
}
async function uiRequest(method, params = {}) {
  if (method === 'call') return call(params.method, params.params || {});
  if (method === 'selectWorkspace') {
    const choice = await dialog.showOpenDialog(window, { title: '选择共享工作空间', defaultPath: manager.snapshot().workspace?.path, properties: ['openDirectory', 'createDirectory'] });
    return choice.canceled ? null : call('workspace.set', { path: choice.filePaths[0] });
  }
  if (method === 'importAssets') {
    const choice = await dialog.showOpenDialog(window, { title: '登记共享素材', properties: ['openFile', 'multiSelections'] });
    if (choice.canceled) return [];
    const records = []; for (const file of choice.filePaths) records.push(await call('assets.import', { path: file, projectId: params.projectId })); return records;
  }
  if (method === 'showInFolder') { shell.showItemInFolder(recordById(params.kind, params.id).path); return { opened: true }; }
  if (method === 'openArtifact') { const record = recordById('artifact', params.id); if (!/\.(mp4|webm|mov|png|jpg|jpeg|gif|wav|mp3|pdf)$/i.test(record.path)) throw new Error('此类型成果请使用所在文件夹打开'); const error = await shell.openPath(record.path); if (error) throw new Error(error); return { opened: true }; }
  if (method === 'copyConnection') { clipboard.writeText(await call('agent.markdown')); return { copied: true }; }
  if (method === 'downloadSkill') {
    const choice = await dialog.showSaveDialog(window, { title: '保存 MediaHub Skill', defaultPath: path.join(app.getPath('downloads'), 'MediaHub-Skill.zip'), filters: [{ name: 'Skill 压缩包', extensions: ['zip'] }] });
    if (choice.canceled) return null;
    const archive = await call('agent.archive');
    const archivePath = typeof archive === 'string' ? archive : archive.path;
    fs.copyFileSync(archivePath, choice.filePath); return { path: choice.filePath };
  }
  if (method === 'openStudio') return openStudio(params.projectId, params.bounds);
  if (method === 'closeStudio') { await closeStudio(); return { closed: true }; }
  throw new Error('不支持的界面操作');
}
function startPipe() {
  if (!fs.existsSync(helperPath)) { log('agent', 'Native helper absent; connection unavailable'); return; }
  pipeServer = spawn(helperPath, ['server', '--pipe', pipeName], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  readline.createInterface({ input: pipeServer.stdout }).on('line', async line => {
    if (Buffer.byteLength(line) > 1024 * 1024 + 200) return;
    let envelope;
    try { envelope = JSON.parse(line); } catch {
      const transportId = line.match(/^\{"transportId":(\d+),/)?.[1];
      if (transportId) pipeServer?.stdin.write(JSON.stringify({ transportId: Number(transportId), response: { id: null, ok: false, error: { code: 'INVALID_JSON', message: '请求 JSON 格式无效' } } }) + '\n');
      return;
    }
    if (envelope.event === 'ready') { pipeReady = true; changed(); return; }
    if (!envelope.transportId || !envelope.request) return;
    const request = envelope.request;
    let response;
    try { if (typeof request.method !== 'string' || request.method.length > 100) throw new Error('请求方法无效'); response = { id: request.id, ok: true, result: await call(request.method, request.params || {}) }; }
    catch (error) { response = { id: request.id, ok: false, error: { code: error.code || 'REQUEST_FAILED', message: error.message } }; }
    pipeServer?.stdin.write(JSON.stringify({ transportId: envelope.transportId, response }) + '\n');
  });
  pipeServer.stderr.on('data', data => log('pipe', String(data)));
  pipeServer.on('error', error => { log('pipe', error.message); pipeServer = null; pipeReady = false; changed(); });
  pipeServer.on('exit', code => { log('pipe', `stopped ${code}`); pipeServer = null; pipeReady = false; changed(); });
  const connection = { schema: 1, protocol: 1, transport: 'windows-named-pipe', pipe: pipeName, pipeName, clientPath: helperPath, powerShellClient: path.join(resourceRoot, 'agent-skill/mediahub/scripts/MediaHub.ps1'), pid: process.pid, version: app.getVersion(), acceptance: !!profile };
  const target = path.join(dataRoot, 'connection.json'); const temporary = target + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(connection, null, 2)); fs.renameSync(temporary, target);
}
async function setupWindow() {
  const uiRoot = path.join(sourceRoot, 'dist/ui');
  protocol.handle('mediahub', async request => {
    const url = new URL(request.url); if (url.host !== 'app' || request.method !== 'GET') return new Response('Forbidden', { status: 403 });
    let filename; try { filename = decodeURIComponent(url.pathname); } catch { return new Response('Bad request', { status: 400 }); }
    const target = path.resolve(uiRoot, '.' + (filename === '/' ? '/index.html' : filename));
    if (!target.startsWith(uiRoot + path.sep)) return new Response('Forbidden', { status: 403 });
    const response = await net.fetch(pathToFileURL(target).href);
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
    return new Response(response.body, { status: response.status, headers });
  });
  window = new BrowserWindow({ width: 1280, height: 850, minWidth: 900, minHeight: 640, title: 'MediaHub', backgroundColor: '#171b1b', show: false, icon: path.join(resourceRoot, 'resources/mediahub.ico'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false } });
  secureSession(window.webContents.session);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('mediahub://app/')) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', (_event, details) => log('renderer', details.reason));
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  window.once('ready-to-show', () => window.show());
  window.webContents.once('did-finish-load', () => { ready = true; changed(); });
  ipcMain.handle('mediahub:ui', async (event, request) => {
    if (!verifySender(event)) return { ok: false, error: { code: 'FORBIDDEN', message: '来源不被允许' } };
    try { return { ok: true, result: await uiRequest(request.method, request.params) }; }
    catch (error) { log('request', `${request.method} ${error.message}`); return { ok: false, error: { code: error.code || 'REQUEST_FAILED', message: error.message } }; }
  });
  ipcMain.on('mediahub:studio-bounds', (event, bounds) => { if (verifySender(event) && studio) { try { studio.setBounds(clampBounds(bounds)); } catch {} } });
  await window.loadURL('mediahub://app/');
}
function setupTray() {
  const iconPath = path.join(resourceRoot, 'resources/mediahub.ico');
  tray = new Tray(nativeImage.createFromPath(iconPath)); tray.setToolTip('MediaHub');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 MediaHub', click: () => { window.show(); window.focus(); } },
    { label: '完成当前任务后退出', click: () => requestQuit('wait') },
    { label: '取消任务后退出', click: () => requestQuit('cancel') },
    { type: 'separator' }, { label: '退出', click: () => requestQuit() }
  ]));
  tray.on('double-click', () => { window.show(); window.focus(); });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'MediaHub', submenu: [{ label: '显示主界面', click: () => window.show() }, { label: '退出', click: () => requestQuit() }] }, { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }]));
}
async function requestQuit(choice) {
  if (quitting) return;
  if (hasWork()) {
    if (!choice) {
      const selected = await dialog.showMessageBox(window, { type: 'question', title: '任务仍在进行', message: 'MediaHub 还有正在进行的任务。', detail: '等待完成后会自动退出。取消后退出会先确认渲染进程停止。', buttons: ['完成后退出', '取消后退出', '继续使用'], defaultId: 0, cancelId: 2 });
      choice = ['wait', 'cancel', 'continue'][selected.response];
    }
    if (choice === 'continue') return;
    quitWait = true;
    if (choice === 'cancel') { for (const task of [...busyTasks(), ...busyOperations()]) await manager.call('tasks.cancel', { taskId: task.id }); await hf.cancelActive(); }
    changed(); return;
  }
  await finishQuit();
}
async function maybeFinishQuit() { if (quitWait && !hasWork() && !quitting) await finishQuit(); }
async function finishQuit() {
  quitting = true; await closeStudio(); await hf.stop();
  pipeServer?.kill(); pipeServer = null;
  await manager?.close();
  try { const target = path.join(dataRoot, 'connection.json'); if (JSON.parse(fs.readFileSync(target, 'utf8')).pid === process.pid) fs.unlinkSync(target); } catch {}
  tray?.destroy(); app.quit();
}

if (!app.requestSingleInstanceLock({ dataRoot })) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); requestQuit().catch(error => log('quit', error.message)); } });
  app.whenReady().then(async () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(resourceRoot, 'resources/catalog.json'), 'utf8'));
    manager = createManager({ dataRoot, resourceRoot, programRoot: app.isPackaged ? path.dirname(app.getPath('exe')) : undefined, catalog, version: app.getVersion(), acceptance: !!profile, allowExternalScan: !!profile?.allowExternalScan, workspaceRoot: profile?.workspaceRoot, pipeName, agentClientPath: helperPath, skillPath: path.join(resourceRoot, 'agent-skill/mediahub'), catalogUrl: 'https://raw.githubusercontent.com/jerryrenjianxing-sys/MediaHub/distribution/catalog/catalog.signed.json', catalogPublicKey: fs.readFileSync(path.join(resourceRoot, 'resources/catalog-public.pem'), 'utf8'), onOpenExternalTool: openExternalTool, onInstallExternal: installExternalTool, onInvokeHyperframes: invokeHyperframes, onComponentHealth: componentHealth, onComponentStop: async () => { await closeStudio(); await hf.stop({ idleOnly: true }); }, onComponentBusy: () => hf.busy || !!studio, onVerifyExternal: (id, executable) => verifyExternal(catalog.tools.find(t => t.id === id), executable), onScanExternal: tool => scanExternal(tool), onArchiveSkill: archiveSkill, onCancelExternalTask: async task => { const response = await hf.request('cancel', { taskId: task.externalId }, 180000); return response; } });
    await manager.ready; manager.on('changed', changed);
    hf.on('stopped', () => { studioUrls.clear(); manager.componentStopped('hyperframes'); });
    hf.on('task', async event => {
      if (event.source !== 'studio') return;
      let taskId = externalTasks.get(event.taskId);
      if (!taskId) { taskId = manager.beginExternalTask({ toolId: 'hyperframes', capabilityId: 'hyperframes.render', projectId: event.projectId, externalId: event.taskId }); externalTasks.set(event.taskId, taskId); }
      try { await manager.updateExternalTask(taskId, { state: event.status || event.state, progress: { phase: event.stage || 'rendering', percent: Number(event.progress) || 0, message: event.stage || '' }, result: event, error: event.error ? { code: event.errorCode || 'RENDER_FAILED', message: String(event.error) } : null }); } catch (error) { log('studio-task', error.message); }
    });
    hf.on('progress', event => {
      const taskId = externalTasks.get(event.taskId);
      if (!taskId) return;
      try { manager.updateExternalTask(taskId, { state: 'running', progress: { phase: event.stage || 'rendering', percent: Number(event.progress) || 0, message: event.stage || '' } }); } catch (error) { log('studio-progress', error.message); }
    });
    startPipe();
    if (app.isPackaged) {
      const { autoUpdater } = require('electron-updater');
      // Keep updater downloads under the same profile root, including acceptance runs.
      Object.defineProperty(autoUpdater.app, 'baseCachePath', { value: path.join(dataRoot, 'updates') });
      if (profile) autoUpdater.installDirectory = path.dirname(app.getPath('exe'));
      updates = new UpdateController({ updater: autoUpdater, dataRoot, version: app.getVersion(), installOptions: { silent: !!profile, forceRunAfter: !profile }, beforeInstall: async () => {
        if (hasWork()) { await dialog.showMessageBox(window, { type: 'info', message: '请等待当前任务完成后安装平台更新。' }); return false; }
        quitting = true; await closeStudio(); await hf.stop({ idleOnly: true }); await manager.close(); pipeServer?.kill(); return true;
      } });
      updates.on('changed', changed);
    }
    await setupWindow(); setupTray();
    manager.call('tools.list', { refresh: true }).catch(error => log('catalog', error.message));
    if (updates) updates.call('check').catch(error => log('update', error.message));
  }).catch(error => { log('fatal', error.stack); dialog.showErrorBox('MediaHub 启动失败', error.message); quitting = true; app.quit(); });
}
