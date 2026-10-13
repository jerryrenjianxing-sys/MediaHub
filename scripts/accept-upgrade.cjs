'use strict';
// Runs only against packaged installers and the real public GitHub update feed.
// Usage: node scripts/accept-upgrade.cjs --old-installer release/MediaHub-0.1.0-preview.1-win-x64-Setup.exe --expected-version 0.1.0-preview.2 --expected-download-url https://github.com/jerryrenjianxing-sys/MediaHub/releases/download/v0.1.0-preview.2/MediaHub-0.1.0-preview.2-win-x64-Setup.exe --expected-sha256 <published-installer-sha256>
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ACCEPTANCE_ROOT = path.join(REPO_ROOT, 'work', 'upgrade-acceptance');
const FEED_URL = 'https://raw.githubusercontent.com/jerryrenjianxing-sys/MediaHub/distribution/updates/preview.yml';
const GUID = 'aa7e9093-a5c7-5c87-baa7-f424dfcf8df6';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function within(root, target) { const relative = path.relative(path.resolve(root), path.resolve(target)); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
function parseOptions(argv) {
  const options = { fromVersion: '0.1.0-preview.1' };
  const names = { '--old-installer': 'oldInstaller', '--expected-version': 'expectedVersion', '--expected-download-url': 'expectedDownloadUrl', '--expected-sha256': 'expectedSha256', '--old-sha256': 'oldSha256', '--from-version': 'fromVersion' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') return { help: true };
    const key = names[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Invalid argument: ${argv[i]}`);
    options[key] = argv[++i];
  }
  for (const key of ['oldInstaller', 'expectedVersion', 'expectedDownloadUrl', 'expectedSha256']) if (!options[key]) throw new Error(`Missing required option: ${key}`);
  const versionPattern = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
  assert.ok(versionPattern.test(options.fromVersion) && versionPattern.test(options.expectedVersion), 'Expected exact release versions');
  assert.notEqual(options.fromVersion, options.expectedVersion, 'The upgrade must change the actual release version');
  for (const key of ['expectedSha256', 'oldSha256']) if (options[key]) { assert.match(options[key], /^[a-fA-F0-9]{64}$/, 'Expected SHA-256 hex'); options[key] = options[key].toLowerCase(); }
  const url = new URL(options.expectedDownloadUrl);
  assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, 'github.com');
  assert.ok(url.pathname.startsWith('/jerryrenjianxing-sys/MediaHub/releases/download/') && url.pathname.endsWith('.exe') && !url.search && !url.hash, 'Expected an immutable public MediaHub GitHub installer asset URL');
  options.expectedDownloadUrl = url.href;
  options.oldInstaller = path.resolve(options.oldInstaller);
  return options;
}
function installerArguments(destination) { return { args: ['/S', `/D=${destination}`], windowsVerbatimArguments: true }; }
async function sha256(file) { const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function runProcess(executable, args, { input, timeout = 120000, windowsVerbatimArguments = false, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, windowsVerbatimArguments, stdio: ['pipe', 'pipe', 'pipe'], ...options });
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error(`Timed out: ${path.basename(executable)}`)); }, timeout);
    function finish(error, value) { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); }
    child.once('error', error => finish(error));
    child.stdout.on('data', data => { stdout += data.toString('utf8'); if (Buffer.byteLength(stdout) > 2 * 1024 ** 2) { child.kill(); finish(new Error('Acceptance process response exceeded its limit')); } });
    child.stderr.on('data', data => { if (stderr.length < 32768) stderr += data.toString('utf8'); });
    child.once('close', code => code === 0 ? finish(null, { stdout, stderr, code, pid: child.pid }) : finish(new Error(`${path.basename(executable)} exited ${code}: ${stderr.trim().slice(0, 2000)}`)));
    child.stdin.end(input === undefined ? '' : input);
  });
}
async function powershellJson(script, params = {}) {
  const preamble = '$ErrorActionPreference="Stop";[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$inputRecord=[Console]::In.ReadToEnd()|ConvertFrom-Json;';
  const command = Buffer.from(preamble + script, 'utf16le').toString('base64');
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await runProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command], { input: JSON.stringify(params), timeout: 45000 });
  return JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ''));
}
const REGISTRY_SCRIPT = `
$items=@();$direct=@()
function Read-StableRegistration($key) {
  $value=Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
  if(-not $value -and (Test-Path -LiteralPath $key)){throw 'A live registration is present but unreadable'}
  return $value
}
foreach($base in @('HKCU:\\Software','HKCU:\\Software\\WOW6432Node')){
  foreach($name in @('${GUID}','{${GUID}}','com.mediahub','com.mediahub.desktop')){
    $key=Join-Path $base $name
    if(Test-Path -LiteralPath $key){
      $value=Read-StableRegistration $key
      if(-not $value){continue}
      $direct+=@{key=$name;displayName='MediaHub';version=$value.DisplayVersion;installLocation=$value.InstallLocation;shortcutName=$value.ShortcutName;menuDirectory=$value.MenuDirectory;kind='install-root'}
    }
  }
}
$items+=$direct
foreach($base in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKCU:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')){
  if(Test-Path -LiteralPath $base){
    foreach($key in Get-ChildItem -LiteralPath $base){
      $value=Read-StableRegistration $key.PSPath
      if(-not $value){continue}
      if($key.PSChildName -match '${GUID}|com\\.mediahub' -or $value.DisplayName -match '^MediaHub(?:$|\\s)' -or $value.UninstallString -match 'com\\.mediahub'){
        $location=$value.InstallLocation
        if(-not $location){
          $match=@($direct|Where-Object{($_.key -replace '[{}]','') -eq ($key.PSChildName -replace '[{}]','')})
          if($match.Count -eq 0 -and $direct.Count -eq 1){$match=@($direct)}
          if($match.Count -eq 1){$location=$match[0].installLocation}
        }
        $items+=@{key=$key.PSChildName;displayName=$value.DisplayName;version=$value.DisplayVersion;installLocation=$location;uninstallString=$value.UninstallString;quietUninstallString=$value.QuietUninstallString;kind='uninstall'}
      }
    }
  }
}
ConvertTo-Json -InputObject @($items) -Compress`;
async function registryEntries() { return powershellJson(REGISTRY_SCRIPT); }
function assertRegistryIsolation(entries, root = ACCEPTANCE_ROOT) {
  for (const entry of entries) {
    assert.ok(typeof entry.installLocation === 'string' && path.isAbsolute(entry.installLocation), 'Existing MediaHub registration has no verifiable InstallLocation; refusing installation');
    assert.ok(within(root, entry.installLocation), 'A MediaHub installation exists outside the acceptance directory; refusing to replace or uninstall it');
  }
}
async function assertNoRunningPlatform() {
  const processes = await powershellJson('$items=@(Get-CimInstance Win32_Process -Filter "Name=\'MediaHub.exe\'" -ErrorAction Stop|ForEach-Object{@{pid=$_.ProcessId;path=$_.ExecutablePath}});ConvertTo-Json -InputObject @($items) -Compress');
  assert.equal(processes.length, 0, 'An existing MediaHub process is running; close it before an installer acceptance');
}
async function exeVersion(file) {
  return powershellJson('$value=(Get-Item -LiteralPath $inputRecord.path).VersionInfo;@{fileVersion=$value.FileVersion;productVersion=$value.ProductVersion;productName=$value.ProductName;fileDescription=$value.FileDescription}|ConvertTo-Json -Compress', { path: file });
}
function cleanupTarget(entries, installRoot, root = ACCEPTANCE_ROOT) {
  assertRegistryIsolation(entries, root);
  assert.ok(entries.length > 0, 'No registered acceptance installation can be verified for cleanup');
  assert.ok(within(root, installRoot) && path.resolve(root).toLowerCase() !== path.resolve(installRoot).toLowerCase(), 'Cleanup target must be a child of the acceptance directory');
  for (const entry of entries) assert.equal(path.resolve(entry.installLocation).toLowerCase(), path.resolve(installRoot).toLowerCase(), 'MediaHub registration belongs to another install root; refusing cleanup');
  const uninstallEntries = entries.filter(entry => entry.kind === 'uninstall');
  assert.equal(uninstallEntries.length, 1, 'Cleanup requires exactly one verifiable MediaHub uninstall registration');
  const record = uninstallEntries[0];
  // Verified electron-builder 26.17.0 NSIS common.nsh/installer.nsh contract:
  // Uninstall ${PRODUCT_FILENAME}.exe, quoted registry path, /currentuser.
  const parsed = String(record.uninstallString || '').match(/^"([^"\r\n]+)"\s+\/currentuser\s*$/i);
  assert.ok(parsed && path.isAbsolute(parsed[1]), 'Registered uninstaller command is not the verified current-user NSIS contract');
  const executable = path.resolve(parsed[1]);
  assert.equal(path.dirname(executable).toLowerCase(), path.resolve(installRoot).toLowerCase(), 'Registered uninstaller is outside the owned application directory');
  assert.equal(path.basename(executable).toLowerCase(), 'uninstall mediahub.exe', 'Registered uninstaller name differs from the MediaHub NSIS contract');
  if (record.quietUninstallString) {
    const quiet = String(record.quietUninstallString).match(/^"([^"\r\n]+)"\s+\/currentuser\s+\/S\s*$/i);
    assert.ok(quiet && path.resolve(quiet[1]).toLowerCase() === executable.toLowerCase(), 'Quiet uninstall registration differs from the verified uninstaller');
  }
  return { executable, args: ['/currentuser', '/S'] };
}
function assertUninstallerIdentity(info, expectedVersion) {
  assert.equal(info.productName, 'MediaHub', 'Uninstaller PE identity is not MediaHub');
  assert.match(String(info.fileDescription || ''), /^MediaHub(?:$|\s)/, 'Uninstaller PE description is not MediaHub');
  // The actual NSIS artifact may use the full preview version or shortVersion.
  const expectedBase = expectedVersion.split('-')[0];
  const actual = String(info.fileVersion || '').trim();
  assert.ok(actual === expectedVersion || actual === expectedBase || actual === `${expectedBase}.0`, 'Uninstaller PE version differs from the acceptance release');
}
async function registeredShortcuts(entries, installRoot) {
  const registration = entries.find(entry => entry.kind === 'install-root');
  assert.ok(registration && typeof registration.shortcutName === 'string' && /^[^\\/:"\x00-\x1f]{1,120}$/.test(registration.shortcutName), 'Missing verifiable NSIS shortcut name');
  const menuDirectory = registration.menuDirectory || '';
  assert.ok(typeof menuDirectory === 'string' && !path.isAbsolute(menuDirectory) && !menuDirectory.split(/[\\/]/).some(part => part === '..') && !/[\x00-\x1f:"]/.test(menuDirectory), 'Invalid registered Start menu directory');
  const links = await powershellJson('$shell=New-Object -ComObject WScript.Shell;$desktop=[Environment]::GetFolderPath("DesktopDirectory");$programs=[Environment]::GetFolderPath("Programs");$menu=$programs;if($inputRecord.menuDirectory){$menu=Join-Path $programs $inputRecord.menuDirectory};$items=@();foreach($link in @((Join-Path $desktop ($inputRecord.shortcutName+".lnk")),(Join-Path $menu ($inputRecord.shortcutName+".lnk")))){$exists=Test-Path -LiteralPath $link;$target=$null;if($exists){$target=$shell.CreateShortcut($link).TargetPath};$items+=@{path=$link;exists=$exists;target=$target}};ConvertTo-Json -InputObject @($items) -Compress', { shortcutName: registration.shortcutName, menuDirectory });
  for (const link of links) if (link.exists) assert.equal(path.resolve(link.target || '').toLowerCase(), path.join(installRoot, 'MediaHub.exe').toLowerCase(), 'MediaHub shortcut points outside the owned acceptance app; refusing cleanup');
  return links;
}
function matchesVersion(info, expected) { return String(info.fileVersion || '').trim() === expected; }
function normalizedUrl(value) { if (value && typeof value === 'object') value = value.url || value.href; if (typeof value !== 'string') return null; try { return new URL(value).href; } catch { return null; } }
function actualDownloadUrl(receipt) {
  for (const value of [receipt?.downloadUrl, receipt?.downloadURL, receipt?.actualDownloadUrl, receipt?.actualDownloadURL, ...(receipt?.downloadUrls || []), ...(receipt?.files || []), ...(receipt?.info?.files || [])]) {
    const url = normalizedUrl(value); if (url?.startsWith('https://github.com/jerryrenjianxing-sys/MediaHub/releases/download/') && new URL(url).pathname.endsWith('.exe')) return url;
  }
  return null;
}
async function realFeedEvidence(expectedVersion, expectedDownloadUrl) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(FEED_URL, { signal: AbortSignal.timeout(30000), headers: { 'Cache-Control': 'no-cache' } });
      assert.equal(response.status, 200, 'The real public update feed is not published');
      const text = await response.text(); assert.ok(text.length < 1024 * 1024, 'Unexpected update feed size');
      const version = text.match(/^version:\s*['"]?([^\s'"]+)/m)?.[1];
      assert.equal(version, expectedVersion, 'The real public preview feed is not the expected release');
      const urls = [...text.matchAll(/^\s*(?:-\s*)?(?:url|path):\s*(.+?)\s*$/gm)].map(match => match[1].replace(/^(['"])(.*)\1$/, '$2'));
      assert.ok(urls.some(url => normalizedUrl(url) === expectedDownloadUrl), 'Published feed does not reference the expected GitHub installer asset');
      return { url: FEED_URL, responseUrl: response.url, sha256: crypto.createHash('sha256').update(text).digest('hex'), version, installerUrl: expectedDownloadUrl, readAt: new Date().toISOString() };
    } catch (error) { lastError = error; if (attempt < 2) await pause(1000); }
  }
  throw lastError;
}
function safePublicError(message) { return String(message || '').replaceAll(REPO_ROOT, '<repo>').replaceAll(REPO_ROOT.replaceAll('\\', '/'), '<repo>').replaceAll(os.homedir(), '<user>').replace(/[A-Za-z]:[\\/][^\n\r"']*/g, '<local-path>'); }
function publicCleanup(value) {
  if (!value) return null;
  const info = value.uninstallerVersionInfo;
  return { passed: value.passed, realNsisUninstaller: value.realNsisUninstaller, uninstallerFileName: path.basename(value.uninstallerFileName), uninstallerVersionInfo: info && { fileVersion: info.fileVersion, productVersion: info.productVersion, productName: info.productName, fileDescription: info.fileDescription }, uninstallerSha256: value.uninstallerSha256, uninstallerExitCode: value.uninstallerExitCode, registryCleared: value.registryCleared, noMediaHubProcesses: value.noMediaHubProcesses, installDirectoryRemoved: value.installDirectoryRemoved, shortcutLocationsChecked: value.shortcutLocationsChecked, shortcutsRemoved: value.shortcutsRemoved, profileRetained: value.profileRetained, workspaceRetained: value.workspaceRetained, chineseProjectRetained: value.chineseProjectRetained, projectMetadataRetained: value.projectMetadataRetained, themeRetained: value.themeRetained, sentinelRetained: value.sentinelRetained };
}
function publicReport(report) {
  return { schema: report.schema, passed: report.passed, startedAt: report.startedAt, completedAt: report.completedAt, profile: 'isolated-packaged-Windows-upgrade', fromVersion: report.fromVersion, expectedVersion: report.expectedVersion, feed: report.feed, initial: report.initial && { installerFileName: path.basename(report.initial.installer), installerSha256: report.initial.installerSha256, installerBytes: report.initial.installerBytes, versionInfo: report.initial.versionInfo, executableSha256: report.initial.executableSha256, snapshotVersion: report.initial.snapshotVersion, fourToolsNotInstalled: report.initial.fourToolsNotInstalled }, download: report.download && { url: report.download.url, expectedSha256: report.download.expectedSha256, actualSha256: report.download.actualSha256, bytes: report.download.bytes, fileName: path.basename(report.download.path) }, upgrade: report.upgrade && { accepted: report.upgrade.accepted, targetVersion: report.upgrade.targetVersion, status: report.upgrade.status, oldProcessExitConfirmed: report.upgrade.oldProcessExitConfirmed, versionInfo: report.upgrade.versionInfo, executableSha256: report.upgrade.executableSha256, snapshotVersion: report.upgrade.snapshotVersion, registryVersionConfirmed: report.upgrade.registryVersionConfirmed }, persistence: report.persistence, cleanup: publicCleanup(report.cleanup), tests: report.tests, error: report.error ? { message: safePublicError(report.error.message) } : undefined };
}
async function findInstaller(updateRoot, receipt, expectedHash) {
  const candidates = [];
  for (const entry of [receipt?.downloadedFile, receipt?.installerPath, ...(receipt?.downloadedFiles || [])]) {
    const file = typeof entry === 'string' ? entry : entry?.path; if (file) { assert.ok(within(updateRoot, file), 'Updater returned an installer outside the acceptance cache'); candidates.push(file); }
  }
  function scan(directory, depth = 0) { if (depth > 7 || !fs.existsSync(directory)) return; for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { if (entry.isSymbolicLink()) continue; const file = path.join(directory, entry.name); if (entry.isDirectory()) scan(file, depth + 1); else if (entry.isFile() && /\.exe$/i.test(file)) candidates.push(file); } }
  scan(updateRoot);
  assert.ok(candidates.length > 0, 'No actual installer was downloaded under this profile');
  for (const file of [...new Set(candidates)]) if (fs.existsSync(file)) { assert.ok(within(updateRoot, fs.realpathSync(file)), 'Updater cache contains an installer escaping its profile'); const hash = await sha256(file); if (hash === expectedHash) return { path: file, sha256: hash, bytes: fs.statSync(file).size }; }
  throw new Error('Downloaded installer does not match the published expected SHA-256');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) { console.log('Usage: node scripts/accept-upgrade.cjs --old-installer <.1-setup.exe> --expected-version <.2> --expected-download-url <public-GitHub-asset-url> --expected-sha256 <64-hex> [--old-sha256 <64-hex>] [--from-version <.1>]\nUses only the real MediaHub GitHub preview feed. Creates work/upgrade-acceptance/app and a unique isolated profile. Refuses any registered or running production MediaHub. Does not uninstall or modify production data.'); return; }
  assert.equal(process.platform, 'win32', 'Packaged installer acceptance requires Windows');
  assert.ok(fs.existsSync(options.oldInstaller) && fs.statSync(options.oldInstaller).isFile(), 'Old installer file is missing');
  const beforeRegistry = await registryEntries(); assertRegistryIsolation(beforeRegistry); await assertNoRunningPlatform();
  const initialInstallerHash = await sha256(options.oldInstaller);
  if (options.oldSha256) assert.equal(initialInstallerHash, options.oldSha256, 'Old installer differs from its published SHA-256');
  const feedEvidence = await realFeedEvidence(options.expectedVersion, options.expectedDownloadUrl);
  // Guard again immediately before launching the first installer, after network waits.
  assertRegistryIsolation(await registryEntries()); await assertNoRunningPlatform();
  const runRoot = path.join(ACCEPTANCE_ROOT, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`);
  const dataRoot = path.join(runRoot, 'data'); const workspaceRoot = path.join(runRoot, '共享 工作空间');
  const installRoot = path.join(ACCEPTANCE_ROOT, 'app'); const application = path.join(installRoot, 'MediaHub.exe');
  const profilePath = path.join(runRoot, 'profile.json'); const connectionFile = path.join(dataRoot, 'connection.json');
  fs.mkdirSync(runRoot, { recursive: true }); fs.mkdirSync(dataRoot, { recursive: true });
  writeJson(profilePath, { acceptance: true, dataRoot, workspaceRoot });
  const report = { schema: 1, passed: false, startedAt: new Date().toISOString(), completedAt: null, fromVersion: options.fromVersion, expectedVersion: options.expectedVersion, feed: feedEvidence, initial: null, download: null, upgrade: null, persistence: null, cleanup: null, tests: [], paths: { runRoot, dataRoot, workspaceRoot, installRoot, profilePath } };
  const save = () => { writeJson(path.join(runRoot, 'report.json'), report); writeJson(path.join(runRoot, 'report.public.json'), publicReport(report)); writeJson(path.join(ACCEPTANCE_ROOT, 'latest.public.json'), publicReport(report)); };
  let running = null;
  function startApplication() {
    const log = fs.createWriteStream(path.join(runRoot, `app-${Date.now()}.log`));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.MEDIAHUB_PROFILE;
    const child = spawn(application, ['--mediahub-profile', profilePath], { cwd: installRoot, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let spawnError; child.once('error', error => { spawnError = error; }); child.stdout.pipe(log); child.stderr.pipe(log); child.once('close', () => log.end());
    running = { child, get error() { return spawnError; } }; return running;
  }
  function connectionFor(processRecord) {
    const connection = readJson(connectionFile);
    assert.equal(connection.protocol, 1); assert.equal(connection.transport, 'windows-named-pipe'); assert.equal(connection.acceptance, true);
    assert.match(connection.pipe, /^[a-zA-Z0-9_.-]{1,160}$/); assert.equal(connection.pid, processRecord.child.pid, 'Connection belongs to another app process');
    assert.ok(path.isAbsolute(connection.clientPath) && within(installRoot, fs.realpathSync(connection.clientPath)), 'Native client is outside the acceptance installation');
    return connection;
  }
  async function call(method, params = {}, timeout = 120000) {
    assert.ok(running, 'No acceptance app process'); const connection = connectionFor(running);
    const id = crypto.randomUUID(); const request = JSON.stringify({ protocol: 1, id, method, params }) + '\n';
    const response = await runProcess(connection.clientPath, ['client', '--pipe', connection.pipe], { input: request, timeout });
    const receipt = JSON.parse(response.stdout.trim()); assert.equal(receipt.id, id, 'Mismatched native request receipt');
    if (receipt.ok !== true) throw Object.assign(new Error(receipt.error?.message || 'Acceptance API call failed'), { code: receipt.error?.code }); return receipt.result;
  }
  async function waitReady(expectedVersion) {
    const deadline = Date.now() + 120000; let lastError;
    while (Date.now() < deadline) {
      if (running.error) throw running.error;
      if (running.child.exitCode !== null) throw new Error(`Acceptance app exited before becoming ready (${running.child.exitCode})`);
      try { const value = await call('platform.snapshot', {}, 15000); if (value.connection?.available && value.connection?.profile === 'acceptance') { assert.equal(value.version, expectedVersion, 'Real packaged snapshot returned an unexpected version'); assert.equal(path.resolve(value.workspace.path).toLowerCase(), workspaceRoot.toLowerCase()); return value; } }
      catch (error) { lastError = error; }
      await pause(300);
    }
    throw new Error(`Acceptance app did not become ready: ${lastError?.message || 'pipe not ready'}`);
  }
  async function waitExit(processRecord, timeout = 180000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (processRecord.child.exitCode !== null || processRecord.child.signalCode !== null) return; await pause(250); } throw new Error('Old acceptance process did not exit after installer acceptance'); }
  try {
    save();
    console.log('Installing the first actual packaged release into the isolated acceptance directory.');
    await runProcess(options.oldInstaller, installerArguments(installRoot).args, { windowsVerbatimArguments: true, timeout: 600000 });
    assertRegistryIsolation(await registryEntries()); assert.ok(fs.existsSync(application), 'Initial actual app executable was not installed');
    const initialInfo = await exeVersion(application); assert.ok(matchesVersion(initialInfo, options.fromVersion), 'Initial PE FileVersion is not the requested old release');
    const oldProcess = startApplication(); const initialSnapshot = await waitReady(options.fromVersion);
    assert.equal(initialSnapshot.tools.length, 4); assert.ok(initialSnapshot.tools.every(tool => tool.status === 'not-installed'));
    report.initial = { installer: options.oldInstaller, installerSha256: initialInstallerHash, installerBytes: fs.statSync(options.oldInstaller).size, versionInfo: initialInfo, executableSha256: await sha256(application), snapshotVersion: initialSnapshot.version, fourToolsNotInstalled: true };
    const project = await call('projects.create', { name: '真实升级验收 中文与空格', orientation: 'portrait' });
    assert.ok(within(workspaceRoot, project.path), 'Created project escaped the acceptance workspace');
    await call('settings.set', { theme: 'dark' });
    const sentinel = path.join(project.path, '升级留存 sentinel.txt'); const sentinelText = `MediaHub real upgrade acceptance\n${crypto.randomUUID()}\n`;
    fs.writeFileSync(sentinel, sentinelText, { flag: 'wx' }); const sentinelHash = await sha256(sentinel); const projectMetadataHash = await sha256(path.join(project.path, 'project.json'));
    report.tests.push('old actual installer and PE version', 'isolated native Agent connection', 'four uninstalled tools', 'Chinese project, dark theme and sentinel established'); save();
    console.log('Checking and downloading the second release through the real GitHub updater.');
    const checked = await call('platform.updates', { action: 'check' }, 180000);
    assert.equal(checked.availableVersion, options.expectedVersion); assert.equal(checked.status, 'available');
    let downloaded; let downloadError;
    try { downloaded = await call('platform.updates', { action: 'download' }, 1200000); }
    catch (error) { downloadError = error; }
    // An IPC timeout is an unknown outcome, never a reason to replay the download.
    if (!downloaded || downloaded.status !== 'downloaded') {
      const deadline = Date.now() + 600000;
      while (Date.now() < deadline) { downloaded = await call('platform.updates', {}, 15000); if (downloaded.status === 'downloaded') break; if (downloaded.status === 'failed') throw new Error(downloaded.error || downloadError?.message || 'Real updater download failed'); await pause(1000); }
    }
    assert.equal(downloaded.status, 'downloaded', downloadError?.message || 'The real updater did not finish downloading'); assert.equal(downloaded.availableVersion, options.expectedVersion);
    const url = actualDownloadUrl(downloaded) || actualDownloadUrl(checked);
    assert.ok(url, 'Updater must expose the actual GitHub installer URL in its download receipt'); assert.equal(url, options.expectedDownloadUrl, 'Actual updater source differs from the expected published GitHub asset');
    const cached = await findInstaller(path.join(dataRoot, 'updates'), downloaded, options.expectedSha256);
    report.download = { url, expectedSha256: options.expectedSha256, actualSha256: cached.sha256, bytes: cached.bytes, path: cached.path, receipt: downloaded }; report.tests.push('real public GitHub feed', 'actual updater download URL receipt', 'downloaded installer SHA-256'); save();
    const beforeUpgrade = await call('platform.snapshot'); assert.equal(beforeUpgrade.settings.theme, 'dark'); assert.ok(beforeUpgrade.projects.some(item => item.id === project.id));
    assertRegistryIsolation(await registryEntries());
    const accepted = await call('platform.updates', { action: 'install' }, 30000);
    assert.equal(accepted.accepted, true); assert.equal(accepted.targetVersion, options.expectedVersion); assert.equal(accepted.status, 'scheduled');
    report.upgrade = { ...accepted, oldProcessExitConfirmed: false }; save();
    await waitExit(oldProcess); report.upgrade.oldProcessExitConfirmed = true; running = null; save();
    console.log('Waiting for the actual installer to apply before restarting the same profile.');
    const applyDeadline = Date.now() + 300000; let appliedInfo, appliedRegistry;
    while (Date.now() < applyDeadline) {
      const entries = await registryEntries(); assertRegistryIsolation(entries);
      if (fs.existsSync(application)) {
        try {
          const info = await exeVersion(application);
          const registered = entries.find(entry => path.resolve(entry.installLocation).toLowerCase() === installRoot.toLowerCase() && String(entry.version).trim() === options.expectedVersion);
          if (matchesVersion(info, options.expectedVersion) && registered) { await pause(2000); const stable = await exeVersion(application); if (matchesVersion(stable, options.expectedVersion)) { appliedInfo = stable; appliedRegistry = registered; break; } }
        } catch (error) { if (/refusing/i.test(error.message)) throw error; }
      }
      await pause(1000);
    }
    assert.ok(appliedInfo && appliedRegistry, 'New release was not applied to the isolated install directory and registry');
    report.upgrade.versionInfo = appliedInfo; report.upgrade.registryVersionConfirmed = true; report.upgrade.executableSha256 = await sha256(application);
    assert.notEqual(report.upgrade.executableSha256, report.initial.executableSha256, 'Actual executable did not change');
    startApplication(); const after = await waitReady(options.expectedVersion); report.upgrade.snapshotVersion = after.version;
    const retained = after.projects.find(item => item.id === project.id); assert.ok(retained, 'Project was lost during platform upgrade');
    assert.equal(retained.name, project.name); assert.equal(retained.orientation, 'portrait'); assert.equal(path.resolve(retained.path).toLowerCase(), path.resolve(project.path).toLowerCase());
    assert.equal(after.settings.theme, 'dark'); assert.equal(await sha256(sentinel), sentinelHash); assert.equal(await sha256(path.join(retained.path, 'project.json')), projectMetadataHash);
    report.persistence = { projectId: project.id, chineseProjectRetained: true, orientationRetained: true, sameProjectDirectory: true, themeRetained: true, sentinelRetained: true, sentinelSha256: sentinelHash, projectMetadataSha256: projectMetadataHash };
    report.tests.push('asynchronous install receipt before old process exit', 'actual installer replaced PE and registry version', 'same-profile restart reports new actual package version', 'project metadata, theme and sentinel retained');
    await call('platform.quit', { mode: 'wait' }, 15000).catch(error => { if (!/pipe|connection|closed|exit|response/i.test(error.message)) throw error; }); await waitExit(running, 60000); running = null;
    console.log('Uninstalling only the verified acceptance app through its real NSIS uninstaller.');
    const cleanupRegistry = await registryEntries(); const cleanup = cleanupTarget(cleanupRegistry, installRoot); await assertNoRunningPlatform();
    assert.ok(within(fs.realpathSync(ACCEPTANCE_ROOT), fs.realpathSync(installRoot)) && within(fs.realpathSync(installRoot), fs.realpathSync(cleanup.executable)), 'Actual cleanup paths escape the acceptance installation');
    assert.equal(path.dirname(fs.realpathSync(cleanup.executable)).toLowerCase(), fs.realpathSync(installRoot).toLowerCase(), 'Actual uninstaller is not directly inside the acceptance app');
    const uninstallerInfo = await exeVersion(cleanup.executable); assertUninstallerIdentity(uninstallerInfo, options.expectedVersion);
    const uninstallerHash = await sha256(cleanup.executable); const shortcuts = await registeredShortcuts(cleanupRegistry, installRoot); const profileHash = await sha256(profilePath);
    report.paths.uninstaller = cleanup.executable; report.paths.shortcuts = shortcuts;
    cleanupTarget(await registryEntries(), installRoot); await assertNoRunningPlatform();
    const uninstallReceipt = await runProcess(cleanup.executable, cleanup.args, { timeout: 300000, cwd: runRoot });
    const cleanupDeadline = Date.now() + 180000; let cleaned = false;
    while (Date.now() < cleanupDeadline) {
      const entries = await registryEntries(); assertRegistryIsolation(entries);
      if (entries.length === 0 && !fs.existsSync(installRoot) && shortcuts.every(link => !fs.existsSync(link.path))) { cleaned = true; break; }
      await pause(500);
    }
    assert.ok(cleaned, 'Acceptance uninstaller did not remove the actual app, registry and shortcuts'); await assertNoRunningPlatform();
    assert.equal(await sha256(profilePath), profileHash, 'Acceptance profile was removed or changed during uninstall');
    assert.ok(fs.statSync(workspaceRoot).isDirectory()); assert.equal(await sha256(path.join(project.path, 'project.json')), projectMetadataHash); assert.equal(await sha256(sentinel), sentinelHash); assert.equal(readJson(path.join(dataRoot, 'settings.json')).theme, 'dark');
    report.cleanup = { passed: true, realNsisUninstaller: true, uninstallerFileName: path.basename(cleanup.executable), uninstallerVersionInfo: uninstallerInfo, uninstallerSha256: uninstallerHash, uninstallerExitCode: uninstallReceipt.code, registryCleared: true, noMediaHubProcesses: true, installDirectoryRemoved: true, shortcutLocationsChecked: shortcuts.length, shortcutsRemoved: true, profileRetained: true, workspaceRetained: true, chineseProjectRetained: true, projectMetadataRetained: true, themeRetained: true, sentinelRetained: true };
    report.tests.push('real current-user NSIS uninstall of guarded acceptance app', 'installation registry and desktop/Start menu shortcuts removed', 'profile, workspace, project metadata, theme and sentinel retained after uninstall');
    report.passed = true; report.completedAt = new Date().toISOString(); save(); console.log('Real GitHub platform upgrade acceptance passed. Public evidence: work/upgrade-acceptance/latest.public.json');
    return report;
  } catch (error) {
    report.error = { code: error.code || 'ACCEPTANCE_FAILED', message: error.message, stack: error.stack }; report.completedAt = new Date().toISOString(); save();
    if (running && running.child.exitCode === null) { try { await call('platform.quit', { mode: 'wait' }, 15000); await waitExit(running, 60000); } catch {} }
    throw error;
  }
}

module.exports = { parseOptions, installerArguments, within, assertRegistryIsolation, cleanupTarget, assertUninstallerIdentity, publicReport, matchesVersion, actualDownloadUrl, registryEntries, exeVersion, main };
if (require.main === module) main().catch(error => { console.error(safePublicError(error.message)); process.exitCode = 1; });
