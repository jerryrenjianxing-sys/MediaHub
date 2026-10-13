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
function installerArguments(toolId, destination, logPath, profilePath) {
  if (toolId === 'media-deep-researcher') return { args: ['--silent', '--installto', destination, '--log', logPath], windowsVerbatimArguments: false };
  // NSIS consumes the remaining command-line tail as /D. Quotes around it change that tail.
  const args = ['/S'];
  // MediaFlow's original installer resolves this profile before extraction, and its
  // install_root is authoritative. NSIS GetOptions strips the value's quotes.
  if (toolId === 'mediaflow') {
    if (!profilePath || !path.isAbsolute(profilePath) || /["\r\n]/.test(profilePath)) throw new Error('MediaFlow acceptance requires an absolute isolated profile path');
    args.push(`/INSTANCEPROFILE="${profilePath}"`);
  }
  args.push(`/D=${destination}`);
  return { args, windowsVerbatimArguments: true };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function redactLog(value) {
  return String(value)
    .replace(/((?:authorization|password|passwd|secret|(?:access[_-]?|refresh[_-]?|agent[_-]?|api[_-]?)?token|api[_-]?key|cookie)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, '[REDACTED]');
}

async function main() {
  assertHostedRunner();
  const repoRoot = path.resolve(__dirname, '..');
  const acceptanceRoot = path.join(repoRoot, 'work', 'legacy-acceptance');
  if (fs.existsSync(path.join(acceptanceRoot, 'report.json'))) throw new Error('Acceptance profile is not fresh; use a new disposable VM.');
  ensureDir(acceptanceRoot);
  const downloads = ensureDir(path.join(acceptanceRoot, 'download-cache'));
  const applicationsRoot = ensureDir(path.join(acceptanceRoot, '应用 中文 空格'));
  const mediaFlowPathMode = process.env.MEDIAHUB_MEDIAFLOW_PATH || 'unicode';
  assert.ok(['unicode', 'ascii'].includes(mediaFlowPathMode), 'Unknown MediaFlow installation path test mode');
  const mediaFlowApplicationsRoot = mediaFlowPathMode === 'ascii' ? ensureDir(path.join(acceptanceRoot, 'Applications with spaces')) : applicationsRoot;
  const applicationRootFor = tool => tool.id === 'mediaflow' ? mediaFlowApplicationsRoot : applicationsRoot;
  const evidenceRoot = ensureDir(path.join(acceptanceRoot, 'evidence'));
  const logsRoot = ensureDir(path.join(acceptanceRoot, 'logs'));
  const preservedRoot = ensureDir(path.join(acceptanceRoot, '留存资料'));
  const originalProfilesRoot = ensureDir(path.join(acceptanceRoot, 'original-profiles'));
  const mediaFlowProfilePath = path.join(originalProfilesRoot, 'mediaflow-instance.json');
  atomicJson(mediaFlowProfilePath, {
    schema: 1, id: 'mediahub_acceptance', acceptance: true,
    install_root: path.join(mediaFlowApplicationsRoot, 'mediaflow'),
    data_root: path.join(originalProfilesRoot, 'mediaflow', 'data'),
    ui_port: 30351, api_port: 48351, stream_port: 48352,
    task_name: 'MediaHub CI MediaFlow Acceptance', shortcut_name: 'MediaFlow MediaHub CI Acceptance',
    registry_key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MediaFlow.Acceptance.MediaHubCI'
  });
  // Original programs support these documented isolated data/discovery locations.
  // All child processes and the read-only identity verifier use the same values.
  process.env.MEDIAWORKBENCH_DATA_DIR = path.join(originalProfilesRoot, 'media-deep-researcher', 'data');
  process.env.MEDIAWORKBENCH_INSTANCE = path.join(originalProfilesRoot, 'media-deep-researcher', 'instance.json');
  process.env.EASEL_DESKTOP_DATA = path.join(originalProfilesRoot, 'mediasail');
  const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, 'resources', 'catalog.json'), 'utf8'));
  const approvedExternalTools = catalog.tools.filter(tool => tool.kind === 'external');
  assert.equal(approvedExternalTools.length, 3, 'Expected the three approved original tools');
  const selectedTool = process.env.MEDIAHUB_LEGACY_TOOL || 'all';
  assert.ok(selectedTool === 'all' || approvedExternalTools.some(tool => tool.id === selectedTool), 'Unknown requested acceptance tool');
  const externalTools = selectedTool === 'all' ? approvedExternalTools : approvedExternalTools.filter(tool => tool.id === selectedTool);
  const report = { schema: 3, startedAt: new Date().toISOString(), completedAt: null, passed: false, profile: 'disposable-github-hosted-windows', selectedTool, fullThreeToolAcceptance: externalTools.length === 3, run: { id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, sha: process.env.GITHUB_SHA }, isolationRoot: acceptanceRoot, tests: [], tools: [], limits: ['Installation, identity, first opening and original-management handoff only; no business workflow, account login, update installation or actual uninstall is performed.'] };
  report.mediaFlowPathMode = mediaFlowPathMode;
  if (mediaFlowPathMode === 'ascii') {
    report.limits.push('MediaFlow installs into an explicitly isolated ASCII path containing spaces. Its original 0.4.1-dev.48 installer failed on a Unicode path in separate real clean Windows tests; ASCII success does not establish Unicode installation support. Shared workspace remains a Unicode path containing spaces.');
    report.knownUnicodeInstallationFailure = { product: 'MediaFlow', version: '0.4.1-dev.48', originalHelper: 'install-mediaflow-background.ps1', line: 38, operation: 'WScript.Shell shortcut.TargetPath assignment', hresult: '0x80070057', evidence: ['https://github.com/jerryrenjianxing-sys/MediaHub/actions/runs/38371037238', 'https://github.com/jerryrenjianxing-sys/MediaHub/actions/runs/38374063016'] };
  }
  let manager;
  const startedTools = new Set();
  const saveReport = () => atomicJson(path.join(acceptanceRoot, 'report.json'), report);
  const resultFor = toolId => report.tools.find(item => item.id === toolId);

  async function collectDiagnostics(tool, destination, logPath) {
    const result = resultFor(tool.id);
    const diagnostics = { collectedAt: new Date().toISOString(), directoryExists: fs.existsSync(destination), observedInstallation: null, candidateDirectories: [], installerLogs: [], transactions: [] };
    try { diagnostics.observedInstallation = await findInstalled(tool, destination); } catch (error) { diagnostics.identityError = error.message; }
    const parent = path.dirname(destination);
    if (fs.existsSync(parent)) for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !['.candidate-', '.failed-'].some(suffix => entry.name.startsWith(path.basename(destination) + suffix))) continue;
      const candidate = path.join(parent, entry.name);
      if (!within(applicationRootFor(tool), candidate)) continue;
      const identity = await findInstalled(tool, candidate);
      diagnostics.candidateDirectories.push({ path: candidate, identity });
    }
    // Never publish connection files or arbitrary account logs. These known
    // original installer logs are bounded and credential-like values are redacted.
    const knownLogs = [logPath, path.join(process.env.LOCALAPPDATA, 'Velopack', 'velopack.log'), path.join(process.env.LOCALAPPDATA, 'SquirrelTemp', 'SquirrelSetup.log')];
    for (const source of knownLogs) {
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
      const bytes = fs.statSync(source).size;
      const descriptor = fs.openSync(source, 'r');
      const content = Buffer.alloc(Math.min(bytes, 256 * 1024));
      try { fs.readSync(descriptor, content, 0, content.length, Math.max(0, bytes - content.length)); } finally { fs.closeSync(descriptor); }
      const output = path.join(logsRoot, `${tool.id}-${path.basename(source)}.redacted.log`);
      fs.writeFileSync(output, redactLog(content.toString('utf8')));
      diagnostics.installerLogs.push({ source, saved: output, sourceBytes: bytes, truncated: bytes > content.length });
    }
    if (tool.id === 'mediaflow') {
      const backups = path.join(originalProfilesRoot, 'mediaflow', 'installer-backups');
      if (fs.existsSync(backups)) for (const entry of fs.readdirSync(backups, { withFileTypes: true }).slice(-10)) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const file = path.join(backups, entry.name, 'transaction.json');
        if (!fs.existsSync(file) || fs.statSync(file).size > 1024 * 1024) continue;
        try {
          const transaction = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
          const fields = ['phase', 'committed', 'mutation_started', 'program_changed', 'install_root', 'candidate_root', 'backup_root', 'task_name', 'profile_path', 'legacy', 'failure_action'];
          const item = { source: file };
          for (const key of fields) if (Object.hasOwn(transaction, key)) item[key] = transaction[key];
          if (transaction.last_error) item.last_error = redactLog(transaction.last_error);
          diagnostics.transactions.push(item);
        } catch (error) { diagnostics.transactions.push({ source: file, error: error.message }); }
      }
      try {
        diagnostics.scheduledTask = await powershellJson("$task=Get-ScheduledTask -TaskName $inputRecord.name -ErrorAction SilentlyContinue;if($task){@{name=$task.TaskName;state=[string]$task.State;principal=@{logonType=[string]$task.Principal.LogonType;runLevel=[string]$task.Principal.RunLevel};actions=@($task.Actions|ForEach-Object{@{execute=$_.Execute;arguments=$_.Arguments}})}|ConvertTo-Json -Depth 5 -Compress}else{'null'}", { name: 'MediaHub CI MediaFlow Acceptance' });
      } catch (error) { diagnostics.scheduledTaskError = error.message; }
      const failedProgram = diagnostics.candidateDirectories.find(item => item.path.startsWith(destination + '.failed-') && item.identity);
      if (failedProgram && !diagnostics.observedInstallation) {
        // The installer has already failed and rolled back. Re-run only its
        // original NoStart registration helper with a fresh diagnostic profile,
        // obtaining ErrorRecord line/stack information that NSIS discarded.
        // This never converts a failed installer receipt into a successful one.
        const diagnosticRoot = ensureDir(path.join(originalProfilesRoot, 'mediaflow-diagnostic'));
        const suffix = crypto.randomUUID();
        const profilePath = path.join(diagnosticRoot, 'profile.json');
        const diagnosticProfile = { ...JSON.parse(fs.readFileSync(mediaFlowProfilePath, 'utf8')), id: 'mediahub_diagnostic', install_root: failedProgram.path, app_root: path.join(failedProgram.path, 'resources', 'platform'), data_root: path.join(diagnosticRoot, 'data'), task_name: `MediaHub CI Diagnostic ${suffix}`, shortcut_name: `MediaFlow CI Diagnostic ${suffix}`, registry_key: `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MediaFlow.Acceptance.Diagnostic-${suffix}` };
        atomicJson(profilePath, diagnosticProfile);
        const helper = path.join(failedProgram.path, 'resources', 'platform', 'install-mediaflow-background.ps1');
        diagnostics.registrationProbe = { noBackgroundStart: true, isolatedDiagnosticProfile: profilePath, helperSha256: fs.existsSync(helper) ? await sha256(helper) : null };
        if (fs.existsSync(helper)) {
          try {
            diagnostics.registrationProbe.result = await powershellJson("$result=@{passed=$false;taskRegistered=$false;cleanup=@()};try{& $inputRecord.helper -NoStart -AppRoot $inputRecord.appRoot -LauncherPath $inputRecord.launcher -InstanceProfilePath $inputRecord.profile|Out-Null;$result.passed=$true;$result.taskRegistered=[bool](Get-ScheduledTask -TaskName $inputRecord.task -ErrorAction SilentlyContinue)}catch{$result.error=@{message=$_.Exception.Message;type=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult;fullyQualifiedErrorId=$_.FullyQualifiedErrorId;position=$_.InvocationInfo.PositionMessage;scriptLine=$_.InvocationInfo.ScriptLineNumber;scriptName=$_.InvocationInfo.ScriptName;stack=$_.ScriptStackTrace}}finally{$task=Get-ScheduledTask -TaskName $inputRecord.task -ErrorAction SilentlyContinue;if($task){if((([string]$task.Actions.Execute)+' '+([string]$task.Actions.Arguments)).IndexOf($inputRecord.appRoot,[StringComparison]::OrdinalIgnoreCase)-ge 0){Unregister-ScheduledTask -TaskName $inputRecord.task -Confirm:$false;$result.cleanup+='diagnostic task removed'}};foreach($folder in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Programs'))){$link=Join-Path $folder ($inputRecord.shortcut+'.lnk');if(Test-Path -LiteralPath $link){Remove-Item -LiteralPath $link -Force;$result.cleanup+='diagnostic shortcut removed'}}};$result|ConvertTo-Json -Depth 5 -Compress", { helper, appRoot: diagnosticProfile.app_root, launcher: failedProgram.identity.installPath, profile: profilePath, task: diagnosticProfile.task_name, shortcut: diagnosticProfile.shortcut_name });
          } catch (error) { diagnostics.registrationProbe.error = redactLog(error.message); }
          if (diagnostics.registrationProbe.result?.error?.position?.includes('TargetPath')) {
            const probeRoot = ensureDir(path.join(diagnosticRoot, 'shortcut-probes'));
            const asciiTargetDirectory = ensureDir(path.join(probeRoot, 'ASCII path with spaces'));
            const copiedExecutable = path.join(asciiTargetDirectory, 'MediaFlow.exe');
            assert.ok(within(diagnosticRoot, copiedExecutable));
            fs.copyFileSync(failedProgram.identity.installPath, copiedExecutable);
            try {
              diagnostics.shortcutTargetProbe = await powershellJson("Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public static class MediaHubShortPathProbe{[DllImport(\"kernel32.dll\",CharSet=CharSet.Unicode,SetLastError=true)]public static extern uint GetShortPathName(string path,StringBuilder result,uint size);}';$buffer=New-Object Text.StringBuilder 4096;$length=[MediaHubShortPathProbe]::GetShortPathName($inputRecord.unicodeTarget,$buffer,4096);$short=if($length -gt 0){$buffer.ToString()}else{$null};$targets=@(@{kind='system-ASCII';path=(Join-Path $env:SystemRoot 'System32\\cmd.exe')},@{kind='original-Unicode';path=$inputRecord.unicodeTarget},@{kind='identical-PE-in-ASCII-space-path';path=$inputRecord.asciiTarget});if($short){$targets+=@{kind='original-short-path';path=$short}};$shell=New-Object -ComObject WScript.Shell;$results=@();foreach($target in $targets){$linkPath=Join-Path $inputRecord.root ($target.kind+'.lnk');$record=@{kind=$target.kind;target=$target.path;targetLength=$target.path.Length;targetExists=(Test-Path -LiteralPath $target.path -PathType Leaf);passed=$false};try{$link=$shell.CreateShortcut($linkPath);$record.objectType=$link.GetType().FullName;$link.TargetPath=[string]$target.path;$record.resolvedTarget=$link.TargetPath;$link.Save();$record.passed=(Test-Path -LiteralPath $linkPath)}catch{$record.error=@{message=$_.Exception.Message;hresult=$_.Exception.HResult;position=$_.InvocationInfo.PositionMessage}}finally{if(Test-Path -LiteralPath $linkPath){Remove-Item -LiteralPath $linkPath -Force}};$results+=$record};@{shortPath=$short;results=$results;executableStarted=$false;shortcutFilesRemoved=$true}|ConvertTo-Json -Depth 5 -Compress", { root: probeRoot, unicodeTarget: failedProgram.identity.installPath, asciiTarget: copiedExecutable });
            } catch (error) { diagnostics.shortcutTargetProbe = { error: redactLog(error.message) }; }
          }
        }
      }
    }
    result.diagnostics = diagnostics;
    atomicJson(path.join(evidenceRoot, `${tool.id}-installer-diagnostics.json`), diagnostics); saveReport();
    if (fs.existsSync(logPath)) fs.writeFileSync(logPath, redactLog(fs.readFileSync(logPath, 'utf8').slice(-256 * 1024)));
    return diagnostics;
  }

  async function processEvidence(installPath) {
    return powershellJson("$items=@();foreach($p in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue){if($p.ExecutablePath -and [string]::Equals($p.ExecutablePath,$inputRecord.path,[StringComparison]::OrdinalIgnoreCase)){try{$live=Get-Process -Id $p.ProcessId -ErrorAction Stop;$items+=@{pid=$p.ProcessId;parentPid=$p.ParentProcessId;executable=$p.ExecutablePath;windowHandle=$live.MainWindowHandle.ToInt64();windowTitle=$live.MainWindowTitle;startedAt=$live.StartTime.ToUniversalTime().ToString('o')}}catch{}}};ConvertTo-Json -InputObject @($items) -Compress", { path: installPath });
  }
  async function observeFirstOpen(tool, installed, action) {
    assert.ok(within(applicationRootFor(tool), installed.installPath), 'Only the isolated original installation may open');
    const result = resultFor(tool.id);
    const launchArgs = tool.id === 'mediaflow' ? [`--instance-profile=${mediaFlowProfilePath}`] : [];
    const launchEnv = { ...process.env, DO_NOT_TRACK: '1', ELECTRON_ENABLE_LOGGING: '1' };
    delete launchEnv.ELECTRON_RUN_AS_NODE;
    const launchReceipt = { executable: installed.installPath, args: launchArgs, windowsHide: false, clearedElectronRunAsNode: true, spawnedAt: new Date().toISOString(), exitCode: null, exitSignal: null };
    let launchOutput = '';
    const child = spawn(installed.installPath, launchArgs, { cwd: path.dirname(installed.installPath), windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'], env: launchEnv });
    const collect = chunk => { launchOutput = (launchOutput + chunk.toString('utf8')).slice(-256 * 1024); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', error => { result.launchError = error.message; });
    child.once('exit', (code, signal) => { launchReceipt.exitCode = code; launchReceipt.exitSignal = signal; launchReceipt.exitedAt = new Date().toISOString(); });
    child.unref(); startedTools.add(tool.id);
    const deadline = Date.now() + 240000;
    let observed = [];
    while (Date.now() < deadline) {
      if (result.launchError) throw new Error(result.launchError);
      observed = await processEvidence(installed.installPath);
      if (observed.some(process => Number(process.windowHandle) !== 0)) break;
      if (launchReceipt.exitedAt && !observed.length) break;
      await pause(1500);
    }
    const logFile = path.join(logsRoot, `${tool.id}-${action}-launch-output.log`);
    fs.writeFileSync(logFile, redactLog(launchOutput));
    const startupLogs = [];
    const knownLogs = tool.id === 'media-deep-researcher' ? [path.join(process.env.MEDIAWORKBENCH_DATA_DIR, 'logs', 'desktop.log'), path.join(process.env.MEDIAWORKBENCH_DATA_DIR, 'logs', 'host.log')] : tool.id === 'mediasail' ? [path.join(process.env.EASEL_DESKTOP_DATA, 'logs', 'desktop.log'), path.join(process.env.EASEL_DESKTOP_DATA, 'logs', 'updates.log')] : [];
    for (const file of knownLogs) if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const saved = path.join(logsRoot, `${tool.id}-${action}-${path.basename(file)}.redacted.log`);
      fs.writeFileSync(saved, redactLog(fs.readFileSync(file, 'utf8').slice(-256 * 1024))); startupLogs.push({ source: file, saved });
    }
    const evidence = { action, requestedAt: launchReceipt.spawnedAt, completedAt: new Date().toISOString(), launchReceipt: { ...launchReceipt }, spawnedPid: child.pid, processes: observed, launchLog: logFile, startupLogs, processObserved: observed.length > 0, windowObserved: observed.some(process => Number(process.windowHandle) !== 0), actualUninstallExecuted: false, businessActionExecuted: false };
    result.entries.push(evidence); atomicJson(path.join(evidenceRoot, `${tool.id}-${action}.json`), evidence); saveReport();
    assert.ok(evidence.processObserved, `${tool.name}: no actual original process was observed`);
    assert.ok(evidence.windowObserved, `${tool.name}: first-launch window was not observed; process presence alone does not prove the interface is ready`);
    return { opened: true, managedBy: 'original', processEvidence: evidence };
  }
  async function findInstalled(tool, destination) {
    const expectedNames = (tool.detection?.processNames || []).map(name => name.replace(/\.exe$/i, '') + '.exe');
    const candidates = [];
    for (const name of expectedNames) {
      // A Velopack root exe is an execution stub. Observe and import the real
      // versioned program under current, which owns the Electron window.
      if (tool.id === 'media-deep-researcher') candidates.push(path.join(destination, 'current', name), path.join(destination, name));
      else candidates.push(path.join(destination, name), path.join(destination, 'current', name));
    }
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
    const destination = path.join(applicationRootFor(tool), tool.id); result.installDirectory = destination;
    const logPath = path.join(logsRoot, `${tool.id}-installer.log`);
    const launch = installerArguments(tool.id, destination, logPath, tool.id === 'mediaflow' ? mediaFlowProfilePath : undefined);
    result.installer = { arguments: launch.args, windowsVerbatimArguments: launch.windowsVerbatimArguments, startedAt: new Date().toISOString() }; saveReport();
    context.progress({ phase: 'installing', percent: 0, message: '原安装器在隔离目录执行' });
    const startedAt = Date.now();
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(installer, launch.args, { windowsHide: true, windowsVerbatimArguments: launch.windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const collect = chunk => { output = (output + chunk.toString('utf8')).slice(-256 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const finishLog = () => fs.writeFileSync(path.join(logsRoot, `${tool.id}-installer-output.log`), redactLog(output));
      const timer = setTimeout(() => { child.kill(); finishLog(); reject(new Error(`${tool.name}: installer exceeded 25 minutes`)); }, 25 * 60 * 1000);
      child.once('error', error => { clearTimeout(timer); finishLog(); reject(error); });
      child.once('exit', code => { clearTimeout(timer); finishLog(); resolve(code); });
    });
    result.installer.exitCode = exitCode; result.installer.elapsedMs = Date.now() - startedAt; saveReport();
    const diagnostics = await collectDiagnostics(tool, destination, logPath);
    // A nonzero original installer receipt remains a failure even if extraction
    // produced a valid PE. That identity is retained solely as diagnosis.
    assert.equal(exitCode, 0, `${tool.name}: original installer returned ${exitCode}${diagnostics.transactions.find(item => item.last_error)?.last_error ? ': ' + diagnostics.transactions.find(item => item.last_error).last_error : ''}`);
    let actual;
    for (let attempt = 0; attempt < 120; attempt++) { actual = await findInstalled(tool, destination); if (actual) break; await pause(1500); }
    assert.ok(actual, `${tool.name}: no verified executable was found in the requested isolated directory`);
    assert.ok(within(applicationRootFor(tool), fs.realpathSync(actual.installPath)), 'Installer path escaped isolation root');
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
    report.host = await powershellJson("@{identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name;userInteractive=[Environment]::UserInteractive;sessionId=(Get-Process -Id $PID).SessionId;taskSchedulerStatus=[string](Get-Service -Name Schedule).Status;desktop=[Environment]::GetFolderPath('Desktop');programs=[Environment]::GetFolderPath('Programs')}|ConvertTo-Json -Compress", {});
    manager = createManager({ dataRoot: path.join(acceptanceRoot, 'platform-profile'), workspacePath: path.join(acceptanceRoot, '共享工作空间 中文 空格'), acceptance: true, catalog, onVerifyExternal: (toolId, executable) => verifyExternal(externalTools.find(tool => tool.id === toolId), executable), onInstallExternal: installOriginal, onOpenExternalTool: (tool, installed, intent) => observeFirstOpen(tool, installed, intent?.action || 'open') });
    await manager.ready;
    assert.ok(manager.snapshot().tools.every(tool => tool.status === 'not-installed'));
    for (const tool of externalTools) {
      const result = resultFor(tool.id); console.log(`Begin original installation: ${tool.name}`);
      try {
      result.phase = 'installation';
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
      result.phase = 'identity-and-import';
      const installed = await manager.call('tools.import', { toolId: tool.id, path: result.identity.installPath });
      assert.equal(installed.management, 'original'); assert.equal(installed.installedVersion, result.actualVersion);
      result.importedRecord = installed;
      const preservedDirectory = ensureDir(path.join(preservedRoot, tool.id));
      result.phase = 'first-opening';
      const firstOpen = await manager.call('tools.open', { toolId: tool.id }); assert.equal(firstOpen.managedBy, 'original');
      const refreshed = await manager.call('tools.import', { toolId: tool.id, path: result.identity.installPath });
      result.afterFirstOpenRecord = refreshed;
      // Empty account fixtures are created only after the real first launch, in this disposable user's declared tool-data directory.
      const declaredDataDirectory = refreshed.dataPaths[0];
      assert.ok(declaredDataDirectory && path.isAbsolute(declaredDataDirectory), 'Original tool must declare its data location');
      ensureDir(declaredDataDirectory);
      const markerValue = crypto.randomUUID();
      const markers = [path.join(preservedDirectory, '原软件资料保留.fixture'), path.join(declaredDataDirectory, `.mediahub-acceptance-${markerValue}.keep`)];
      for (const marker of markers) fs.writeFileSync(marker, markerValue, { flag: 'wx' });
      result.phase = 'original-management-entries-and-preservation';
      for (const action of ['updateEntry', 'uninstallEntry']) {
        const response = await manager.call(`tools.${action}`, { toolId: tool.id });
        assert.equal(response.managedBy, 'original');
        for (const marker of markers) assert.equal(fs.readFileSync(marker, 'utf8'), markerValue);
        assert.ok(fs.existsSync(result.identity.installPath), 'Original entry handoff must not remove program files');
        assert.equal((await manager.call('tools.status', { toolId: tool.id })).status, 'installed');
      }
      result.preservation = { markerPaths: markers, declaredToolDataPath: declaredDataDirectory, fixture: 'Fresh empty-account sentinel, not a production account or database', sentinelSha256: crypto.createHash('sha256').update(markerValue).digest('hex'), afterManagementEntries: 'unchanged', programStillPresent: true, actualUninstallExecuted: false };
      result.passed = true; result.phase = 'completed'; report.tests.push(`${tool.name}: verified download, actual install, actual identity, import, observed original window, update/uninstall handoff and retained data`); saveReport();
      } catch (error) {
        result.failure = { code: error.code || 'LEGACY_TOOL_ACCEPTANCE_FAILED', message: redactLog(error.message), stack: redactLog(error.stack) };
        if (result.installDirectory && !result.diagnostics) {
          try { await collectDiagnostics(tool, result.installDirectory, path.join(logsRoot, `${tool.id}-installer.log`)); } catch (diagnosticError) { result.diagnosticsError = diagnosticError.message; }
        }
        console.error(`${tool.name}: ${result.phase} failed: ${result.failure.message}`);
        saveReport();
      }
    }
    report.passed = report.tools.every(result => result.passed); report.platformSnapshot = manager.snapshot();
    if (!report.passed) {
      report.failure = { code: 'LEGACY_ACCEPTANCE_FAILED', message: report.tools.filter(result => !result.passed).map(result => `${result.name}: ${result.failure?.message || 'Not completed'}`).join('\n') };
      process.exitCode = 1;
    }
  } catch (error) {
    report.failure = { code: error.code || 'LEGACY_ACCEPTANCE_FAILED', message: error.message, stack: error.stack };
    process.exitCode = 1;
  } finally {
    if (manager) await manager.close();
    // Stop only executables beneath this run's explicitly checked application root.
    if (startedTools.size) {
      const ownedProgramRoots = [...new Set([applicationsRoot, mediaFlowApplicationsRoot])];
      assert.ok(ownedProgramRoots.every(root => within(acceptanceRoot, root)), 'Cleanup program roots must remain inside acceptance isolation');
      try { report.cleanup = await powershellJson("$stopped=@();$prefixes=@($inputRecord.roots|ForEach-Object{[IO.Path]::GetFullPath($_).TrimEnd('\\')+'\\'});foreach($p in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue){if($p.ExecutablePath -and @($prefixes|Where-Object{$p.ExecutablePath.StartsWith($_,[StringComparison]::OrdinalIgnoreCase)}).Count){try{Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop;$stopped+=$p.ProcessId}catch{}}};@{stoppedPids=$stopped;programsAndDataDeleted=$false}|ConvertTo-Json -Compress", { roots: ownedProgramRoots }); } catch (error) { report.cleanup = { error: error.message }; }
    }
    report.completedAt = new Date().toISOString(); saveReport();
    console.log(`Legacy acceptance ${report.passed ? 'passed' : 'failed'}; report: ${path.join(acceptanceRoot, 'report.json')}`);
    if (report.failure) console.error(report.failure.message);
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { assertHostedRunner, installerArguments };
