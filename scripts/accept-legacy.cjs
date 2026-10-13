'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createManager } = require('../desktop/core/manager.cjs');
const { downloadVerified } = require('../desktop/core/packages.cjs');
const { ensureDir, atomicJson, sha256, within } = require('../desktop/core/files.cjs');
const { verifyExternal, scanExternal, powershellJson } = require('../desktop/external-tools.cjs');

function assertHostedRunner(env = process.env, platform = process.platform) {
  if (platform !== 'win32' || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.RUNNER_OS !== 'Windows' || !env.GITHUB_RUN_ID || !env.RUNNER_TEMP) {
    throw new Error('This acceptance may run only in a disposable GitHub-hosted Windows runner; personal and self-hosted machines are refused.');
  }
}
function installerArguments(toolId, destination, logPath) {
  if (toolId === 'media-deep-researcher') return { args: ['--silent', '--installto', destination, '--log', logPath], windowsVerbatimArguments: false };
  // NSIS consumes the remaining command-line tail as /D. Quotes around it change that tail.
  return { args: ['/S', `/D=${destination}`], windowsVerbatimArguments: true };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  assertHostedRunner();
  const repoRoot = path.resolve(__dirname, '..');
  const acceptanceRoot = path.join(repoRoot, 'work', 'legacy-acceptance');
  if (fs.existsSync(path.join(acceptanceRoot, 'report.json'))) throw new Error('Acceptance profile is not fresh; use a new disposable VM.');
  ensureDir(acceptanceRoot);
  const downloads = ensureDir(path.join(acceptanceRoot, 'download-cache'));
  const applicationsRoot = ensureDir(path.join(acceptanceRoot, '应用 中文 空格'));
  const evidenceRoot = ensureDir(path.join(acceptanceRoot, 'evidence'));
  const logsRoot = ensureDir(path.join(acceptanceRoot, 'logs'));
  const preservedRoot = ensureDir(path.join(acceptanceRoot, '留存资料'));
  const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, 'resources', 'catalog.json'), 'utf8'));
  const externalTools = catalog.tools.filter(tool => tool.kind === 'external');
  assert.equal(externalTools.length, 3, 'Expected the three approved original tools');
  const report = { schema: 1, startedAt: new Date().toISOString(), completedAt: null, passed: false, profile: 'disposable-github-hosted-windows', run: { id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, sha: process.env.GITHUB_SHA }, isolationRoot: acceptanceRoot, tests: [], tools: [], limits: ['Installation, identity, first opening and original-management handoff only; no business workflow, account login, update installation or actual uninstall is performed.'] };
  let manager;
  const startedTools = new Set();
  const saveReport = () => atomicJson(path.join(acceptanceRoot, 'report.json'), report);
  const resultFor = toolId => report.tools.find(item => item.id === toolId);

  async function processEvidence(installPath) {
    return powershellJson("$items=@();foreach($p in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue){if($p.ExecutablePath -and [string]::Equals($p.ExecutablePath,$inputRecord.path,[StringComparison]::OrdinalIgnoreCase)){try{$live=Get-Process -Id $p.ProcessId -ErrorAction Stop;$items+=@{pid=$p.ProcessId;parentPid=$p.ParentProcessId;executable=$p.ExecutablePath;windowHandle=$live.MainWindowHandle.ToInt64();windowTitle=$live.MainWindowTitle;startedAt=$live.StartTime.ToUniversalTime().ToString('o')}}catch{}}};ConvertTo-Json -InputObject @($items) -Compress", { path: installPath });
  }
  async function observeFirstOpen(tool, installed, action) {
    assert.ok(within(applicationsRoot, installed.installPath), 'Only the isolated original installation may open');
    const result = resultFor(tool.id);
    const child = spawn(installed.installPath, [], { cwd: path.dirname(installed.installPath), windowsHide: true, stdio: 'ignore', env: { ...process.env, DO_NOT_TRACK: '1' } });
    child.once('error', error => { result.launchError = error.message; }); child.unref(); startedTools.add(tool.id);
    const deadline = Date.now() + 120000;
    let observed = [];
    while (Date.now() < deadline) {
      if (result.launchError) throw new Error(result.launchError);
      observed = await processEvidence(installed.installPath);
      if (observed.some(process => Number(process.windowHandle) !== 0)) break;
      await pause(1500);
    }
    const evidence = { action, requestedAt: new Date().toISOString(), spawnedPid: child.pid, processes: observed, processObserved: observed.length > 0, windowObserved: observed.some(process => Number(process.windowHandle) !== 0), actualUninstallExecuted: false, businessActionExecuted: false };
    result.entries.push(evidence); atomicJson(path.join(evidenceRoot, `${tool.id}-${action}.json`), evidence); saveReport();
    assert.ok(evidence.processObserved, `${tool.name}: no actual original process was observed`);
    assert.ok(evidence.windowObserved, `${tool.name}: first-launch window was not observed; process presence alone does not prove the interface is ready`);
    return { opened: true, managedBy: 'original', processEvidence: evidence };
  }
  async function findInstalled(tool, destination) {
    const expectedNames = (tool.detection?.processNames || []).map(name => name.replace(/\.exe$/i, '') + '.exe');
    const candidates = [];
    for (const name of expectedNames) candidates.push(path.join(destination, name), path.join(destination, 'current', name));
    const walk = (directory, depth = 0) => {
      if (depth > 4 || !fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const candidate = path.join(directory, entry.name);
        if (entry.isFile() && expectedNames.some(name => name.toLowerCase() === entry.name.toLowerCase())) candidates.push(candidate);
        else if (entry.isDirectory() && !['node_modules', 'app.asar.unpacked'].includes(entry.name)) walk(candidate, depth + 1);
      }
    };
    walk(destination);
    for (const executable of [...new Set(candidates)]) {
      if (!fs.existsSync(executable)) continue;
      try { return await verifyExternal(tool, executable); } catch (error) { resultFor(tool.id).candidateErrors.push({ path: executable, message: error.message }); }
    }
    return null;
  }
  async function installOriginal(tool, context) {
    const result = resultFor(tool.id);
    const installer = path.join(downloads, tool.install.fileName);
    const begin = Date.now(); let lastPercent = -1;
    await downloadVerified(tool.install, installer, { signal: context.signal, progress: progress => {
      context.progress(progress);
      const percent = Math.floor((progress.percent || 0) / 10) * 10;
      if (percent !== lastPercent) { lastPercent = percent; console.log(`${tool.name}: ${progress.phase} ${percent}%`); }
    } });
    const actualChecksum = await sha256(installer);
    assert.equal(actualChecksum, tool.install.sha256);
    result.download = { url: tool.install.url, expectedSha256: tool.install.sha256, actualSha256: actualChecksum, bytes: fs.statSync(installer).size, elapsedMs: Date.now() - begin };
    const destination = path.join(applicationsRoot, tool.id); result.installDirectory = destination;
    const logPath = path.join(logsRoot, `${tool.id}-installer.log`);
    const launch = installerArguments(tool.id, destination, logPath);
    result.installer = { arguments: launch.args, windowsVerbatimArguments: launch.windowsVerbatimArguments, startedAt: new Date().toISOString() }; saveReport();
    context.progress({ phase: 'installing', percent: 0, message: '原安装器在隔离目录执行' });
    const startedAt = Date.now();
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(installer, launch.args, { windowsHide: true, windowsVerbatimArguments: launch.windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'pipe'] });
      const stream = fs.createWriteStream(path.join(logsRoot, `${tool.id}-installer-output.log`));
      child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`${tool.name}: installer exceeded 25 minutes`)); }, 25 * 60 * 1000);
      child.once('error', error => { clearTimeout(timer); stream.end(); reject(error); });
      child.once('exit', code => { clearTimeout(timer); stream.end(); resolve(code); });
    });
    result.installer.exitCode = exitCode; result.installer.elapsedMs = Date.now() - startedAt; saveReport();
    assert.equal(exitCode, 0, `${tool.name}: original installer returned ${exitCode}`);
    let actual;
    for (let attempt = 0; attempt < 120; attempt++) { actual = await findInstalled(tool, destination); if (actual) break; await pause(1500); }
    assert.ok(actual, `${tool.name}: no verified executable was found in the requested isolated directory`);
    assert.ok(within(applicationsRoot, fs.realpathSync(actual.installPath)), 'Installer path escaped isolation root');
    result.identity = actual; result.actualVersion = actual.version; result.catalogVersion = tool.version;
    assert.notEqual(actual.version, '', 'Actual VersionInfo version must be present');
    saveReport();
    return actual;
  }

  try {
    saveReport();
    const disk = fs.statfsSync(acceptanceRoot); const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    report.freeBytesBefore = freeBytes;
    assert.ok(freeBytes > externalTools.reduce((total, tool) => total + tool.install.bytes, 0) * 3, 'Hosted runner has insufficient disk space for isolated acceptance');
    for (const tool of externalTools) {
      const existing = await scanExternal(tool);
      assert.equal(existing, null, `${tool.name} was already installed; this runner is not a clean acceptance profile`);
      report.tools.push({ id: tool.id, name: tool.name, passed: false, candidateErrors: [], entries: [], cleanRunnerNoExistingInstall: true });
    }
    report.tests.push('Clean runner has no recognized original installation'); saveReport();
    manager = createManager({ dataRoot: path.join(acceptanceRoot, 'platform-profile'), workspacePath: path.join(acceptanceRoot, '共享工作空间 中文 空格'), acceptance: true, catalog, onVerifyExternal: (toolId, executable) => verifyExternal(externalTools.find(tool => tool.id === toolId), executable), onInstallExternal: installOriginal, onOpenExternalTool: (tool, installed, intent) => observeFirstOpen(tool, installed, intent?.action || 'open') });
    await manager.ready;
    assert.ok(manager.snapshot().tools.every(tool => tool.status === 'not-installed'));
    for (const tool of externalTools) {
      const result = resultFor(tool.id); console.log(`Begin original installation: ${tool.name}`);
      const operation = await manager.call('tools.install', { toolId: tool.id }); result.platformInstallOperationId = operation.id; saveReport();
      let completed;
      const deadline = Date.now() + 40 * 60 * 1000;
      while (Date.now() < deadline) {
        const current = await manager.call('tasks.get', { taskId: operation.id });
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(current.state)) { completed = current; break; }
        await pause(500);
      }
      assert.ok(completed, `${tool.name}: management operation did not finish`);
      result.platformInstall = completed; saveReport();
      assert.equal(completed.state, 'completed', completed.error?.message || `${tool.name}: install operation failed`);
      const installed = await manager.call('tools.import', { toolId: tool.id, path: result.identity.installPath });
      assert.equal(installed.management, 'original'); assert.equal(installed.installedVersion, result.actualVersion);
      result.importedRecord = installed;
      const preservedDirectory = ensureDir(path.join(preservedRoot, tool.id));
      const firstOpen = await manager.call('tools.open', { toolId: tool.id }); assert.equal(firstOpen.managedBy, 'original');
      // Empty account fixtures are created only after the real first launch, in this disposable user's declared tool-data directory.
      const declaredDataDirectory = installed.dataPaths[0];
      assert.ok(declaredDataDirectory && path.isAbsolute(declaredDataDirectory), 'Original tool must declare its data location');
      ensureDir(declaredDataDirectory);
      const markerValue = crypto.randomUUID();
      const markers = [path.join(preservedDirectory, '原软件资料保留.fixture'), path.join(declaredDataDirectory, `.mediahub-acceptance-${markerValue}.keep`)];
      for (const marker of markers) fs.writeFileSync(marker, markerValue, { flag: 'wx' });
      for (const action of ['updateEntry', 'uninstallEntry']) {
        const response = await manager.call(`tools.${action}`, { toolId: tool.id });
        assert.equal(response.managedBy, 'original');
        for (const marker of markers) assert.equal(fs.readFileSync(marker, 'utf8'), markerValue);
        assert.ok(fs.existsSync(result.identity.installPath), 'Original entry handoff must not remove program files');
        assert.equal((await manager.call('tools.status', { toolId: tool.id })).status, 'installed');
      }
      result.preservation = { markerPaths: markers, declaredToolDataPath: declaredDataDirectory, fixture: 'Fresh empty-account sentinel, not a production account or database', sentinelSha256: crypto.createHash('sha256').update(markerValue).digest('hex'), afterManagementEntries: 'unchanged', programStillPresent: true, actualUninstallExecuted: false };
      result.passed = true; report.tests.push(`${tool.name}: verified download, actual install, actual identity, import, observed original window, update/uninstall handoff and retained data`); saveReport();
    }
    report.passed = report.tools.every(result => result.passed); report.platformSnapshot = manager.snapshot();
  } catch (error) {
    report.failure = { code: error.code || 'LEGACY_ACCEPTANCE_FAILED', message: error.message, stack: error.stack };
    process.exitCode = 1;
  } finally {
    if (manager) await manager.close();
    // Stop only executables beneath this run's explicitly checked application root.
    if (startedTools.size) {
      try { report.cleanup = await powershellJson("$stopped=@();$prefix=[IO.Path]::GetFullPath($inputRecord.root).TrimEnd('\\')+'\\';foreach($p in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue){if($p.ExecutablePath -and $p.ExecutablePath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){try{Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop;$stopped+=$p.ProcessId}catch{}}};@{stoppedPids=$stopped;programsAndDataDeleted=$false}|ConvertTo-Json -Compress", { root: applicationsRoot }); } catch (error) { report.cleanup = { error: error.message }; }
    }
    report.completedAt = new Date().toISOString(); saveReport();
    console.log(`Legacy acceptance ${report.passed ? 'passed' : 'failed'}; report: ${path.join(acceptanceRoot, 'report.json')}`);
    if (report.failure) console.error(report.failure.message);
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { assertHostedRunner, installerArguments };
