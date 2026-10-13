'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const semver = require('semver');
const { fault, ensureDir, readJson, atomicJson, assertWithin, within, id, safeName, sha256, nonSymlink } = require('./files.cjs');
const { validateCatalog, verifyEnvelope } = require('./catalog.cjs');
const { request, downloadVerified, extractZip } = require('./packages.cjs');

const DEFAULT_TOOLS = [
  { id: 'mediaflow', name: 'MediaFlow', kind: 'external', description: '设备与自动化任务' },
  { id: 'media-deep-researcher', name: 'Media Deep Researcher', kind: 'external', description: '采集、研究与数据分析' },
  { id: 'mediasail', name: 'MediaSail', kind: 'external', description: '画像、素材、内容和运营资料' },
  { id: 'hyperframes', name: 'HyperFrames', kind: 'component', description: '视频制作、预览与渲染' }
];
const FINISHED = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const clone = x => JSON.parse(JSON.stringify(x));
const now = () => new Date().toISOString();
const expandEnv = x => x.replace(/%([^%]+)%/g, (_, name) => process.env[name] || `%${name}%`);

function createManager(options = {}) {
  if (!options.dataRoot) throw fault('CONFIG', '需要独立平台数据目录');
  const emitter = new EventEmitter();
  const dataRoot = path.resolve(options.dataRoot);
  const componentsRoot = path.join(dataRoot, 'components');
  const cacheRoot = path.join(dataRoot, 'downloads');
  const records = { tools: {}, tasks: {}, operations: {} };
  const controllers = new Map();
  const componentLocks = new Set();
  let closed = false; let db;
  let catalog = validateCatalog(options.catalog || readJson(path.join(options.resourceRoot || dataRoot, 'catalog.json'), { schemaVersion: 1, tools: DEFAULT_TOOLS }));
  let settings = { theme: 'system', workspacePath: options.acceptance ? path.join(dataRoot, 'acceptance-workspace') : path.join(os.homedir(), 'Documents', 'MediaHubWorkspace') };
  let workspace; let projects = []; let assets = []; let artifacts = [];
  const connection = { protocol: 1, transport: 'windows-named-pipe', pipe: options.pipeName || null, clientPath: options.agentClientPath || options.helperPath || null, profile: options.acceptance ? 'acceptance' : 'default' };
  let connectionFile;

  function save(kind, value) {
    db.prepare('INSERT INTO records(kind,id,json) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json').run(kind, value.id, JSON.stringify(value));
    records[kind][value.id] = value;
  }
  function changed() { if (!closed) emitter.emit('changed', snapshot()); }
  function requireTool(toolId) { const tool = catalog.tools.find(x => x.id === toolId); if (!tool) throw fault('NOT_FOUND', '工具不存在'); return tool; }
  function requireProject(projectId) { const p = projects.find(x => x.id === projectId); if (!p) throw fault('NOT_FOUND', '项目不存在'); return p; }
  function validActive(toolRoot, value) {
    if (!value?.version || !/^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,80}$/.test(value.version)) return null;
    const expected = path.join(toolRoot, 'versions', value.version);
    if (typeof value.path !== 'string' || path.resolve(value.path) !== expected || !fs.existsSync(path.join(expected, 'manifest.json'))) return null;
    if (fs.lstatSync(expected).isSymbolicLink() || !within(fs.realpathSync(toolRoot), fs.realpathSync(expected))) return null;
    return { ...value, path: expected };
  }
  function requireIdle(toolId, ignoreId) {
    if (componentLocks.has(toolId) || [...Object.values(records.tasks), ...Object.values(records.operations)].some(t => t.id !== ignoreId && t.toolId === toolId && !FINISHED.has(t.state))) throw fault('TOOL_BUSY', '工具正在执行任务，请结束后再操作');
    if (records.tools[toolId]?.status === 'running' && typeof options.onComponentStop !== 'function') throw fault('TOOL_BUSY', '请先停止工具预览再操作');
    if (options.onComponentBusy?.(toolId)) throw fault('TOOL_BUSY', '组件正在执行任务');
  }
  function toolView(tool) {
    const installed = records.tools[tool.id] || {};
    return { id: tool.id, name: tool.name, description: tool.description || '', kind: tool.kind, management: tool.kind === 'external' ? 'original' : 'platform', status: installed.status || 'not-installed', version: installed.version || null, installedVersion: installed.version || null, availableVersion: tool.version || null, installPath: installed.installPath || null, dataPaths: installed.dataPaths || [], entryUrl: installed.entryUrl || tool.links?.home || null, downloadBytes: tool.package?.bytes || tool.install?.bytes || null, canInstall: !!(tool.package || tool.install || tool.links?.download), canUpdate: !!tool.version && installed.version !== tool.version, error: installed.error || null, originalManaged: tool.kind === 'external' };
  }
  function snapshot() {
    return clone({ version: options.version || '0.1.0-preview.1', workspace, tools: catalog.tools.map(toolView), projects, assets, artifacts, tasks: Object.values(records.tasks).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), operations: Object.values(records.operations).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), connection: { ...connection, connectionFile }, settings });
  }
  function indexWorkspace() {
    projects = []; assets = []; artifacts = [];
    const projectRoot = ensureDir(path.join(workspace.path, 'projects'));
    for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const dir = path.join(projectRoot, entry.name);
      let project;
      try { project = readJson(path.join(dir, 'project.json'), null); } catch { continue; }
      if (project?.id && /^[a-zA-Z0-9_-]{1,100}$/.test(project.id) && !projects.some(p => p.id === project.id) && typeof project.name === 'string' && within(fs.realpathSync(projectRoot), fs.realpathSync(dir))) {
        projects.push({ ...project, path: dir });
        const registered = readJson(path.join(dir, 'artifacts.json'), []);
        for (const item of Array.isArray(registered) ? registered : []) {
          if (!item.id || item.projectId !== project.id || typeof item.path !== 'string' || !path.isAbsolute(item.path) || !within(dir, item.path)) continue;
          if (fs.existsSync(item.path) && (!fs.statSync(item.path).isFile() || !within(fs.realpathSync(dir), fs.realpathSync(item.path)))) continue;
          artifacts.push({ ...item, path: path.resolve(item.path), projectId: project.id });
        }
      }
    }
    const registry = readJson(path.join(workspace.path, 'assets', 'assets.json'), []);
    if (Array.isArray(registry)) assets = registry.filter(a => a?.id && typeof a.path === 'string' && path.isAbsolute(a.path) && within(path.join(workspace.path, 'assets'), a.path) && (!fs.existsSync(a.path) || (fs.statSync(a.path).isFile() && within(fs.realpathSync(path.join(workspace.path, 'assets')), fs.realpathSync(a.path)))));
    db.exec('DELETE FROM workspace_index');
    const insert = db.prepare('INSERT INTO workspace_index(kind,id,json) VALUES(?,?,?)');
    db.exec('BEGIN');
    try { for (const [kind, list] of [['projects', projects], ['assets', assets], ['artifacts', artifacts]]) for (const value of list) insert.run(kind, value.id, JSON.stringify(value)); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  function setWorkspace(target) {
    if (typeof target !== 'string' || !path.isAbsolute(target)) throw fault('INVALID_PATH', '请选择绝对工作空间路径');
    target = path.resolve(target);
    if (within(componentsRoot, target) || within(cacheRoot, target) || within(target, componentsRoot) || within(target, cacheRoot)) throw fault('INVALID_PATH', '工作空间必须与程序及下载目录分开');
    if (Object.values(records.tasks).some(t => !FINISHED.has(t.state))) throw fault('BUSY', '任务执行期间不能切换工作空间');
    ensureDir(target); nonSymlink(target);
    const marker = path.join(target, 'workspace.json');
    workspace = readJson(marker, null);
    if (!workspace) { workspace = { id: id('workspace'), name: path.basename(target), createdAt: now() }; atomicJson(marker, workspace); }
    workspace = { ...workspace, path: target };
    ensureDir(path.join(target, 'assets')); ensureDir(path.join(target, 'projects'));
    settings.workspacePath = target; atomicJson(path.join(dataRoot, 'settings.json'), settings);
    indexWorkspace();
    return clone(workspace);
  }
  function transition(kind, record, patch) { const updated = { ...record, ...patch, updatedAt: now() }; save(kind, updated); changed(); return updated; }
  function run(kind, type, toolId, projectId, fn) {
    const item = { id: id(kind === 'tasks' ? 'task' : 'operation'), type, capabilityId: type, toolId, projectId: projectId || null, state: 'queued', progress: { phase: 'queued', percent: 0, message: '已受理' }, createdAt: now(), updatedAt: now(), result: null, error: null };
    save(kind, item); changed();
    const controller = new AbortController(); controllers.set(item.id, controller);
    const context = { taskId: item.id, signal: controller.signal, progress: progress => {
      const current = records[kind][item.id]; if (!FINISHED.has(current.state)) transition(kind, current, { progress: { ...current.progress, ...progress } });
    } };
    setImmediate(async () => {
      let current = transition(kind, records[kind][item.id], { state: controller.signal.aborted ? 'cancelling' : 'running' });
      try {
        controller.signal.throwIfAborted();
        const result = await fn(context);
        current = records[kind][item.id];
        // A fulfilled adapter confirms the real result, even when cancellation lost a race.
        // Only an acknowledged abort/error reports cancelled; an AbortSignal alone is a request.
        transition(kind, current, { state: 'completed', result: result ?? null, progress: { ...current.progress, phase: 'completed', percent: 100 } });
      } catch (error) {
        current = records[kind][item.id];
        transition(kind, current, { state: error.code === 'CANCELLED' || error.name === 'AbortError' ? 'cancelled' : 'failed', error: { code: error.code || 'OPERATION_FAILED', message: error.message || String(error) } });
      } finally { controllers.delete(item.id); }
    });
    return clone(item);
  }
  async function scanExternal() {
    let imports = options.externalRecords || [];
    if (!options.acceptance || options.allowExternalScan) {
      for (const tool of catalog.tools.filter(t => t.kind === 'external')) {
        if (options.onScanExternal) {
          const discovered = await options.onScanExternal(tool);
          if (discovered) imports.push({ ...discovered, id: tool.id });
          continue;
        }
        for (const candidate of tool.detection?.executables || []) {
          const target = path.resolve(expandEnv(typeof candidate === 'string' ? candidate : candidate.path));
          if (!fs.existsSync(target) || !fs.statSync(target).isFile()) continue;
          let version = typeof candidate === 'object' ? candidate.version || null : null;
          const versionFile = typeof candidate === 'object' && candidate.versionFile ? expandEnv(candidate.versionFile) : null;
          if (versionFile && fs.existsSync(versionFile)) version = readJson(versionFile, {}).version || version;
          if (!options.onVerifyExternal) continue;
          const verified = await options.onVerifyExternal(tool.id, target);
          imports.push({ id: tool.id, installPath: target, version: verified?.version || version, dataPaths: verified?.dataPaths || (tool.detection.dataPaths || []).map(expandEnv), entryUrl: tool.links?.home || null });
          break;
        }
      }
    }
    for (const installed of imports) {
      const tool = requireTool(installed.id);
      if (tool.kind !== 'external') continue;
      save('tools', { ...installed, id: tool.id, status: 'installed', source: 'registered', updatedAt: now() });
    }
  }
  async function refreshCatalog() {
    if (!options.catalogUrl || !options.catalogPublicKey) throw fault('CATALOG_UNAVAILABLE', '目录更新尚未配置');
    const response = await request(options.catalogUrl);
    const chunks = []; let size = 0;
    for await (const chunk of response) { size += chunk.length; if (size > 2 * 1024 ** 2) { response.destroy(); throw fault('CATALOG_SIZE', '工具目录过大'); } chunks.push(chunk); }
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const next = verifyEnvelope(envelope, options.catalogPublicKey);
    const floor = readJson(path.join(dataRoot, 'catalog-revision.json'), { sequence: 0 }).sequence;
    if (!Number.isSafeInteger(next.sequence) || next.sequence < floor || next.sequence < (catalog.sequence || 0)) throw fault('CATALOG_ROLLBACK', '工具目录版本过旧或缺少顺序标识');
    catalog = next; atomicJson(path.join(dataRoot, 'catalog-revision.json'), { sequence: next.sequence });
    atomicJson(path.join(dataRoot, 'catalog.signed.json'), envelope); changed(); return catalog.tools.map(toolView);
  }
  async function installComponent(tool, context) {
    if (!tool.package) throw fault('NO_RELEASE', '组件发行包尚未发布');
    requireIdle(tool.id, context.taskId); componentLocks.add(tool.id);
    const root = ensureDir(path.join(componentsRoot, tool.id));
    const stage = path.join(root, `.staging-${crypto.randomUUID()}`);
    const final = path.join(root, 'versions', tool.version);
    const activeFile = path.join(root, 'active.json');
    const previous = validActive(root, readJson(activeFile, null));
    if (previous?.version && semver.valid(tool.version) && semver.valid(previous.version) && semver.lt(tool.version, previous.version)) { componentLocks.delete(tool.id); throw fault('COMPONENT_DOWNGRADE', '目录提供了较旧的组件版本'); }
    try {
      if (options.onComponentStop) await options.onComponentStop(tool.id);
      context.signal.throwIfAborted();
      const disk = fs.statfsSync(root); if (Number(disk.bavail) * Number(disk.bsize) < tool.package.bytes * 3) throw fault('DISK_SPACE', '磁盘可用空间不足');
      transition('tools', records.tools[tool.id] || { id: tool.id }, { status: 'installing', error: null });
      const archive = await downloadVerified(tool.package, path.join(cacheRoot, `${tool.id}-${tool.version}-${tool.package.sha256.slice(0, 12)}.zip`), context);
      context.progress({ phase: 'installing', percent: 0 });
      await extractZip(archive, stage, { signal: context.signal });
      const manifest = readJson(path.join(stage, 'manifest.json'), null);
      if (!manifest || manifest.id !== tool.id || manifest.version !== tool.version) throw fault('INVALID_COMPONENT', '组件身份或版本与目录不符');
      if (typeof options.onComponentHealth !== 'function') throw fault('HEALTH_UNAVAILABLE', '尚未配置组件健康检查');
      await options.onComponentHealth(tool.id, { path: stage, version: tool.version, manifest, signal: context.signal });
      context.signal.throwIfAborted();
      ensureDir(path.dirname(final)); nonSymlink(path.dirname(final));
      if (fs.existsSync(final)) {
        const existing = readJson(path.join(final, 'manifest.json'), null);
        if (existing?.id !== tool.id || existing?.version !== tool.version) throw fault('VERSION_CONFLICT', '版本目录冲突');
        await options.onComponentHealth(tool.id, { path: final, version: tool.version, manifest: existing, signal: context.signal });
      } else fs.renameSync(stage, final);
      atomicJson(activeFile, { version: tool.version, path: final, activatedAt: now() });
      await options.onComponentHealth(tool.id, { path: final, version: tool.version, manifest, signal: context.signal });
      save('tools', { id: tool.id, status: 'installed', version: tool.version, installPath: final, dataPaths: [path.join(dataRoot, 'tool-data', tool.id)], source: 'component', updatedAt: now() });
      changed(); return toolView(tool);
    } catch (error) {
      if (previous) atomicJson(activeFile, previous); else if (fs.existsSync(activeFile)) fs.unlinkSync(activeFile);
      if (previous && options.onComponentHealth) {
        try { await options.onComponentHealth(tool.id, { path: previous.path, version: previous.version, manifest: readJson(path.join(previous.path, 'manifest.json')), recovery: true }); } catch (recoveryError) { error.message += `；旧版本健康检查失败：${recoveryError.message}`; }
      }
      save('tools', { id: tool.id, status: previous ? 'installed' : 'failed', version: previous?.version || null, installPath: previous?.path || null, error: { code: error.code || 'INSTALL_FAILED', message: error.message }, updatedAt: now() }); changed(); throw error;
    } finally { componentLocks.delete(tool.id); if (fs.existsSync(stage)) fs.rmSync(assertWithin(root, stage), { recursive: true, force: true }); }
  }
  function capabilities() {
    return ['create', 'preview', 'lint', 'check', 'render', 'import', 'stop'].map(action => ({ id: `hyperframes.${action}`, toolId: 'hyperframes', action, name: { create: '创建视频工程', preview: '打开预览', lint: '静态检查', check: '检查工程', render: '导出 MP4', import: '导入素材', stop: '停止预览' }[action], available: ['installed', 'running'].includes(records.tools.hyperframes?.status) && typeof options.onInvokeHyperframes === 'function' && (!options.hyperframesActions || options.hyperframesActions.includes(action)), requiresProject: true }));
  }
  function registerArtifact(params) {
    const project = requireProject(params.projectId);
    if (!params.path || !path.isAbsolute(params.path) || !within(project.path, params.path)) throw fault('INVALID_PATH', '成果必须保存在对应项目内');
    const actualPath = nonSymlink(params.path);
    if (!fs.statSync(actualPath).isFile() || !within(fs.realpathSync(project.path), actualPath)) throw fault('INVALID_PATH', '成果不是有效的项目文件');
    const existing = artifacts.find(a => a.path === actualPath && a.projectId === project.id);
    if (existing) return existing;
    const artifact = { id: id('artifact'), name: params.name || path.basename(actualPath), path: actualPath, projectId: project.id, toolId: params.toolId || null, taskId: params.taskId || null, media: params.media || null, createdAt: now() };
    artifacts.push(artifact); atomicJson(path.join(project.path, 'artifacts.json'), artifacts.filter(a => a.projectId === project.id)); indexWorkspace(); changed(); return artifact;
  }
  async function call(method, params = {}) {
    await ready; if (closed) throw fault('CLOSED', '平台管理器已关闭');
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw fault('INVALID_PARAMS', '参数格式无效');
    switch (method) {
      case 'tools.list': return params.refresh ? refreshCatalog() : catalog.tools.map(toolView);
      case 'tools.status': return toolView(requireTool(params.toolId || params.id));
      case 'tools.import': {
        const tool = requireTool(params.toolId || params.id);
        if (tool.kind !== 'external') throw fault('INVALID_TOOL', '组件应通过平台安装');
        if (typeof params.path !== 'string' || !path.isAbsolute(params.path) || !fs.existsSync(params.path)) throw fault('INVALID_PATH', '安装路径不存在');
        const installPath = nonSymlink(params.path);
        if (!fs.statSync(installPath).isFile() || path.extname(installPath).toLowerCase() !== '.exe') throw fault('INVALID_PATH', '请选择工具可执行文件');
        let verified = null;
        if (options.onVerifyExternal) verified = await options.onVerifyExternal(tool.id, installPath);
        else throw fault('IDENTITY_UNVERIFIED', '无法确认可执行文件属于该工具');
        save('tools', { id: tool.id, status: 'installed', installPath, version: verified?.version || null, dataPaths: verified?.dataPaths || [], updatedAt: now() }); changed(); return toolView(tool);
      }
      case 'tools.install': {
        const tool = requireTool(params.toolId || params.id);
        if (tool.kind === 'component') { requireIdle(tool.id); return run('operations', 'install', tool.id, null, context => installComponent(tool, context)); }
        requireIdle(tool.id);
        if (typeof options.onInstallExternal !== 'function') throw fault('INSTALL_UNAVAILABLE', '原软件安装入口尚未配置');
        return run('operations', 'install', tool.id, null, async context => {
          const result = await options.onInstallExternal(tool, context);
          if (result?.installPath) {
            if (!fs.existsSync(result.installPath)) throw fault('INSTALL_NOT_FOUND', '安装程序结束后未找到工具');
            save('tools', { id: tool.id, status: 'installed', installPath: result.installPath, version: result.version || null, dataPaths: result.dataPaths || [], updatedAt: now() }); changed();
          }
          return result || { managedBy: 'original', message: '已打开原软件安装入口，请完成安装后重新扫描' };
        });
      }
      case 'tools.rescan': await scanExternal(); changed(); return catalog.tools.map(toolView);
      case 'tools.open': {
        const tool = requireTool(params.toolId || params.id); const installed = records.tools[tool.id];
        if (!installed?.installPath) throw fault('NOT_INSTALLED', '工具尚未安装');
        if (tool.kind === 'component') {
          if (!params.projectId) throw fault('PROJECT_REQUIRED', '请选择项目后打开 HyperFrames');
          return call('capabilities.invoke', { capabilityId: 'hyperframes.preview', projectId: params.projectId });
        }
        if (typeof options.onOpenExternalTool !== 'function') throw fault('OPEN_UNAVAILABLE', '工具打开入口尚未配置');
        await options.onOpenExternalTool(tool, clone(installed)); return { opened: true, managedBy: 'original' };
      }
      case 'tools.updateEntry': {
        const tool = requireTool(params.toolId || params.id);
        if (tool.kind === 'component') return call('tools.install', params);
        if (!options.onOpenExternalTool) throw fault('OPEN_UNAVAILABLE', '原软件入口尚未配置');
        await options.onOpenExternalTool(tool, clone(records.tools[tool.id] || {}), { action: 'update' }); return { opened: true, managedBy: 'original' };
      }
      case 'tools.uninstallEntry': {
        const tool = requireTool(params.toolId || params.id);
        if (tool.kind === 'external') {
          if (!options.onOpenExternalTool) throw fault('OPEN_UNAVAILABLE', '原软件卸载入口尚未配置');
          await options.onOpenExternalTool(tool, clone(records.tools[tool.id] || {}), { action: 'uninstall' }); return { opened: true, managedBy: 'original', dataPreserved: true };
        }
        if (Object.values(records.tasks).some(t => t.toolId === tool.id && !FINISHED.has(t.state)) || componentLocks.has(tool.id) || options.onComponentBusy?.(tool.id)) throw fault('TOOL_BUSY', '工具正在执行任务');
        if (options.onComponentStop) await options.onComponentStop(tool.id);
        if (records.tools[tool.id]?.status === 'running') save('tools', { ...records.tools[tool.id], status: 'installed', entryUrl: null });
        requireIdle(tool.id);
        const root = assertWithin(componentsRoot, path.join(componentsRoot, tool.id));
        if (fs.existsSync(root)) { nonSymlink(root); fs.rmSync(root, { recursive: true, force: true }); }
        save('tools', { id: tool.id, status: 'not-installed', version: null, installPath: null, updatedAt: now() }); changed(); return { uninstalled: true, dataPreserved: true };
      }
      case 'workspace.get': return clone(workspace);
      case 'workspace.set': { const value = setWorkspace(params.path); changed(); return value; }
      case 'projects.list': indexWorkspace(); return clone(projects);
      case 'projects.create': {
        if (!String(params.name || '').trim()) throw fault('INVALID_NAME', '请填写项目名称');
        if (params.orientation && !['landscape', 'portrait'].includes(params.orientation)) throw fault('INVALID_ORIENTATION', '画面方向无效');
        const project = { id: id('project'), name: String(params.name).trim().slice(0, 200), orientation: params.orientation || 'landscape', createdAt: now() };
        const dir = ensureDir(path.join(workspace.path, 'projects', `${safeName(project.name)}-${project.id.slice(-8)}`));
        atomicJson(path.join(dir, 'project.json'), project); atomicJson(path.join(dir, 'artifacts.json'), []); indexWorkspace(); changed(); return projects.find(p => p.id === project.id);
      }
      case 'assets.list': return clone(assets.filter(a => !params.projectId || a.projectId === params.projectId));
      case 'assets.import': {
        if (!params.path || !path.isAbsolute(params.path)) throw fault('INVALID_PATH', '素材路径必须为绝对路径');
        const sourcePath = nonSymlink(params.path); const stat = fs.statSync(sourcePath);
        if (!stat.isFile()) throw fault('INVALID_PATH', '请选择素材文件');
        const asset = { id: id('asset'), name: params.name || path.basename(sourcePath), sourcePath, bytes: stat.size, sha256: await sha256(sourcePath), projectId: params.projectId || null, createdAt: now() };
        if (asset.projectId) requireProject(asset.projectId);
        const target = path.join(workspace.path, 'assets', asset.id, safeName(path.basename(sourcePath))); ensureDir(path.dirname(target)); fs.copyFileSync(sourcePath, target, fs.constants.COPYFILE_EXCL); asset.path = target;
        assets.push(asset); atomicJson(path.join(workspace.path, 'assets', 'assets.json'), assets); indexWorkspace(); changed(); return asset;
      }
      case 'artifacts.list': return clone(artifacts.filter(a => !params.projectId || a.projectId === params.projectId));
      case 'artifacts.register': return clone(registerArtifact(params));
      case 'tasks.list': return clone([...Object.values(records.tasks), ...(params.includeOperations ? Object.values(records.operations) : [])]);
      case 'tasks.get': { const value = records.tasks[params.taskId || params.id] || records.operations[params.taskId || params.id]; if (!value) throw fault('NOT_FOUND', '任务不存在'); return clone(value); }
      case 'tasks.cancel': {
        const taskId = params.taskId || params.id; const kind = records.tasks[taskId] ? 'tasks' : 'operations'; const item = records[kind][taskId];
        if (!item) throw fault('NOT_FOUND', '任务不存在');
        if (FINISHED.has(item.state)) return clone(item);
        if (item.external) {
          if (!options.onCancelExternalTask) throw fault('CANCEL_UNAVAILABLE', '外部任务取消入口尚未配置');
          transition(kind, item, { state: 'cancelling', progress: { ...item.progress, message: '正在确认取消' } });
          const result = await options.onCancelExternalTask(clone(item));
          if (result?.state === 'cancelled') updateExternalTask(taskId, { state: 'cancelled', result });
          return clone(records[kind][taskId]);
        }
        const controller = controllers.get(taskId); if (!controller) throw fault('UNKNOWN_TASK', '任务状态未知，不能安全取消');
        transition(kind, item, { state: 'cancelling', progress: { ...item.progress, message: '正在确认取消' } }); controller.abort(); return clone(records[kind][taskId]);
      }
      case 'capabilities.list': return capabilities();
      case 'capabilities.describe': { const cap = capabilities().find(c => c.id === (params.capabilityId || params.id)); if (!cap) throw fault('NOT_FOUND', '能力不存在'); return { ...cap, inputs: ['projectId', 'options'], reference: 'references/hyperframes.md' }; }
      case 'capabilities.invoke': {
        const cap = capabilities().find(c => c.id === (params.capabilityId || params.id)); if (!cap) throw fault('NOT_FOUND', '能力不存在'); if (!cap.available) throw fault('CAPABILITY_UNAVAILABLE', '工具尚未安装或适配器未就绪');
        const project = requireProject(params.projectId); const installed = records.tools.hyperframes;
        if (componentLocks.has('hyperframes')) throw fault('TOOL_BUSY', '工具正在安装或更新');
        if (cap.action === 'render' && Object.values(records.tasks).some(t => t.capabilityId === cap.id && !FINISHED.has(t.state))) throw fault('RENDER_BUSY', '已有视频导出任务');
        return run('tasks', cap.id, 'hyperframes', project.id, async context => {
          const args = { ...(params.options || {}), projectDir: project.path, projectId: project.id, workspaceId: workspace.id, workspacePath: workspace.path, componentPath: installed.installPath, orientation: project.orientation };
          if (cap.action === 'import' && args.assetId) { const asset = assets.find(a => a.id === args.assetId); if (!asset) throw fault('NOT_FOUND', '素材不存在'); args.asset = clone(asset); }
          const result = await options.onInvokeHyperframes(cap.action, args, context);
          if (cap.action === 'preview') save('tools', { ...records.tools.hyperframes, status: 'running', entryUrl: result?.url || result?.previewUrl || null });
          if (cap.action === 'stop') save('tools', { ...records.tools.hyperframes, status: 'installed', entryUrl: null });
          if (cap.action === 'render') {
            if (!result?.artifact?.mediaValidated) throw fault('MEDIA_NOT_VALIDATED', '渲染结果尚未通过媒体检查');
            result.artifact = registerArtifact({ ...result.artifact, projectId: project.id, toolId: 'hyperframes', taskId: context.taskId });
          }
          return result;
        });
      }
      case 'agent.connection': return clone({ ...connection, connectionFile, skillPath: options.skillPath || path.join(options.resourceRoot || '', 'agent-skill', 'mediahub') });
      case 'agent.markdown': return `请使用 MediaHub 总 Skill 接入我已打开的平台。Skill: ${options.skillPath || path.join(options.resourceRoot || '', 'agent-skill', 'mediahub')}\n连接文件: ${connectionFile}\n先只读查询 tools.list、workspace.get 和 capabilities.list，再根据我的任务按需读取详细工具说明。不要安装全局配置。`;
      case 'agent.archive': if (!options.onArchiveSkill) throw fault('ARCHIVE_UNAVAILABLE', '技能下载入口尚未配置'); return options.onArchiveSkill({ connectionFile, skillPath: options.skillPath });
      case 'settings.get': return clone(settings);
      case 'settings.set': {
        if (params.theme !== undefined && !['light', 'dark', 'system'].includes(params.theme)) throw fault('INVALID_THEME', '主题无效');
        if (params.workspacePath && params.workspacePath !== settings.workspacePath) setWorkspace(params.workspacePath);
        if (params.theme !== undefined) settings.theme = params.theme;
        atomicJson(path.join(dataRoot, 'settings.json'), settings); changed(); return clone(settings);
      }
      default: throw fault('UNKNOWN_METHOD', `未知平台操作：${method}`);
    }
  }
  const ready = Promise.resolve().then(async () => {
    ensureDir(dataRoot); ensureDir(componentsRoot); ensureDir(cacheRoot);
    db = new DatabaseSync(path.join(dataRoot, 'platform.sqlite'));
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS workspace_index(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id));');
    for (const row of db.prepare('SELECT kind,id,json FROM records').all()) if (records[row.kind]) records[row.kind][row.id] = JSON.parse(row.json);
    for (const kind of ['tasks', 'operations']) for (const record of Object.values(records[kind])) if (!FINISHED.has(record.state)) save(kind, { ...record, state: 'interrupted', error: { code: 'RESTARTED', message: '平台异常退出，结果待检查；未自动重放' }, updatedAt: now() });
    settings = { ...settings, ...readJson(path.join(dataRoot, 'settings.json'), {}) };
    if (options.workspacePath || options.workspaceRoot) settings.workspacePath = options.workspacePath || options.workspaceRoot;
    const cached = readJson(path.join(dataRoot, 'catalog.signed.json'), null);
    if (cached && options.catalogPublicKey) {
      try {
        const candidate = verifyEnvelope(cached, options.catalogPublicKey);
        const floor = readJson(path.join(dataRoot, 'catalog-revision.json'), { sequence: 0 }).sequence;
        if (Number.isSafeInteger(candidate.sequence) && candidate.sequence >= floor && candidate.sequence >= (catalog.sequence || 0)) catalog = candidate;
      } catch { /* Use trusted bundled bootstrap when cached catalog is invalid. */ }
    }
    setWorkspace(settings.workspacePath);
    for (const tool of catalog.tools.filter(t => t.kind === 'component')) {
      const active = validActive(path.join(componentsRoot, tool.id), readJson(path.join(componentsRoot, tool.id, 'active.json'), null));
      if (active) save('tools', { id: tool.id, status: 'installed', version: active.version, installPath: active.path, dataPaths: [path.join(dataRoot, 'tool-data', tool.id)], updatedAt: now() });
      else if (records.tools[tool.id]?.installPath) save('tools', { id: tool.id, status: 'not-installed', version: null, installPath: null, updatedAt: now() });
    }
    await scanExternal();
    connectionFile = path.join(dataRoot, 'connection.json'); atomicJson(connectionFile, { ...connection, clientPath: connection.clientPath, skillPath: options.skillPath || null });
    return snapshot();
  });
  async function close({ cancel = false } = {}) {
    await ready;
    if (closed) return;
    if (cancel) for (const controller of controllers.values()) controller.abort();
    if (cancel && options.onCancelExternalTask) for (const task of Object.values(records.tasks)) if (task.external && !FINISHED.has(task.state)) await call('tasks.cancel', { taskId: task.id });
    while (controllers.size || Object.values(records.tasks).some(t => t.external && !FINISHED.has(t.state))) await new Promise(resolve => setTimeout(resolve, 50));
    closed = true; db.close(); emitter.removeAllListeners();
  }
  function beginExternalTask({ toolId, capabilityId, projectId, externalId }) {
    requireTool(toolId); if (projectId) requireProject(projectId);
    const existing = Object.values(records.tasks).find(t => t.externalId === externalId && t.toolId === toolId);
    if (existing) return existing.id;
    const record = { id: id('task'), toolId, capabilityId, type: capabilityId, projectId: projectId || null, externalId, external: true, state: 'running', progress: { phase: 'running', percent: 0 }, createdAt: now(), updatedAt: now(), result: null, error: null };
    save('tasks', record); changed(); return record.id;
  }
  function updateExternalTask(taskId, patch) {
    const current = records.tasks[taskId]; if (!current?.external) throw fault('NOT_FOUND', '外部任务不存在');
    if (FINISHED.has(current.state)) return clone(current);
    if (patch.state && !['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted'].includes(patch.state)) throw fault('INVALID_STATE', '任务状态无效');
    if (patch.state === 'completed' && current.capabilityId === 'hyperframes.render') {
      if (!patch.result?.artifact?.mediaValidated) throw fault('MEDIA_NOT_VALIDATED', '渲染结果尚未通过媒体检查');
      patch.result.artifact = registerArtifact({ ...patch.result.artifact, projectId: current.projectId, toolId: current.toolId, taskId });
    }
    return clone(transition('tasks', current, { state: patch.state || current.state, progress: patch.progress || current.progress, result: patch.result || current.result, error: patch.error || current.error }));
  }
  return { ready, snapshot, call, on: emitter.on.bind(emitter), once: emitter.once.bind(emitter), off: emitter.off.bind(emitter), close, beginExternalTask, updateExternalTask, get busy() { return controllers.size > 0 || Object.values(records.tasks).some(t => !FINISHED.has(t.state)); } };
}
module.exports = { createManager, DEFAULT_TOOLS };
