'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const helper = process.env.MEDIAHUB_NATIVE_HELPER || path.join(__dirname, '../build/native/mediahub-pipe.exe');
const available = process.platform === 'win32' && fs.existsSync(helper);
async function delay(ms) { await new Promise(resolve => setTimeout(resolve, ms)); }
async function connectPipe(endpoint) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return await new Promise((resolve, reject) => { const socket = net.createConnection(endpoint); socket.once('error', reject); socket.once('connect', () => { socket.removeListener('error', reject); resolve(socket); }); }); } catch { await delay(25); }
  }
  throw new Error('pipe did not become available');
}
function runClient(pipe, request) {
  return new Promise((resolve, reject) => {
    const client = spawn(helper, ['client', '--pipe', pipe], { windowsHide: true }); let stdout = '';
    client.stdout.on('data', data => { stdout += data; }); client.once('error', reject); client.once('exit', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`client exit ${code}`)));
    client.stdin.end(JSON.stringify(request) + '\n');
  });
}
test('native current-user pipe transports framed JSON and refuses an oversized frame', { skip: !available ? 'Requires compiled Windows helper' : false }, async t => {
  const name = `MediaHub-test-${crypto.randomUUID()}`; const server = spawn(helper, ['server', '--pipe', name], { windowsHide: true });
  t.after(() => server.kill());
  readline.createInterface({ input: server.stdout }).on('line', line => { const envelope = JSON.parse(line); if (!envelope.transportId) return; server.stdin.write(JSON.stringify({ transportId: envelope.transportId, response: { ok: true, result: envelope.request } }) + '\n'); });
  const socket = await connectPipe(`\\\\.\\pipe\\${name}`);
  const oversize = Buffer.alloc(4); oversize.writeUInt32LE(1024 * 1024 + 1); socket.write(oversize);
  await new Promise(resolve => { socket.once('close', resolve); socket.once('error', resolve); socket.resume(); });
  const response = await runClient(name, { method: 'tools.list', params: { label: '中文 项目' } });
  assert.equal(response.ok, true); assert.equal(response.result.params.label, '中文 项目');
});
test('native job helper kills owned child and grandchild when the supervisor exits', { skip: !available ? 'Requires compiled Windows helper' : false }, async t => {
  const script = "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); console.log(JSON.stringify({pid:process.pid,grandchild:child.pid})); setInterval(()=>{},1000);";
  const supervisor = spawn(helper, ['job', '--', process.execPath, '-e', script], { windowsHide: true }); t.after(() => supervisor.kill());
  const pids = await new Promise((resolve, reject) => { let text = ''; supervisor.once('error', reject); supervisor.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) resolve(JSON.parse(text.trim())); }); });
  supervisor.kill(); await new Promise(resolve => supervisor.once('exit', resolve));
  for (let attempt = 0; attempt < 100; attempt++) { let alive = false; for (const pid of [pids.pid, pids.grandchild]) { try { process.kill(pid, 0); alive = true; } catch {} } if (!alive) return; await delay(25); }
  assert.fail('owned process survived supervisor shutdown');
});
test('native rejects remote path or invalid pipe name before opening a connection', { skip: !available ? 'Requires compiled Windows helper' : false }, async () => {
  const code = await new Promise((resolve, reject) => { const client = spawn(helper, ['client', '--pipe', '\\\\remote\\pipe\\MediaHub'], { windowsHide: true }); client.once('error', reject); client.once('exit', resolve); client.stdin.end('{}\n'); });
  assert.notEqual(code, 0);
});

test('actual named-pipe DACL grants only the current SID and rejects a remote transport connection', { skip: !available ? 'Requires compiled Windows helper' : false }, async t => {
  const name = `MediaHub-acl-${crypto.randomUUID()}`; const server = spawn(helper, ['server', '--pipe', name], { windowsHide: true }); t.after(() => server.kill());
  const initial = await connectPipe(`\\\\.\\pipe\\${name}`); initial.destroy();
  const script = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PipeAclProbe {
 [StructLayout(LayoutKind.Sequential)] struct SidAttributes { public IntPtr Sid; public uint Attributes; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint sharing,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSidToSid(string text,out IntPtr sid);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr original,uint flags,uint disableCount,IntPtr disabled,uint deleteCount,IntPtr deleted,uint restrictCount,ref SidAttributes restricted,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool ImpersonateLoggedOnUser(IntPtr token);
 [DllImport("advapi32.dll")] static extern bool RevertToSelf();
 [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(IntPtr handle,int type,uint info,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor,uint revision,uint info,out IntPtr text,out uint size);
 public static string Read(string name) {
  IntPtr h=CreateFile(name,0x00020000,0,IntPtr.Zero,3,0,IntPtr.Zero);
  if(h==new IntPtr(-1)) throw new Exception("Open pipe error "+Marshal.GetLastWin32Error());
  IntPtr owner,group,dacl,sacl,descriptor;
  try {
   uint error=GetSecurityInfo(h,6,4,out owner,out group,out dacl,out sacl,out descriptor);
   if(error!=0) throw new Exception("Read pipe ACL error "+error);
   try { IntPtr text; uint size; if(!ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor,1,4,out text,out size)) throw new Exception("Convert ACL failed"); try{return Marshal.PtrToStringUni(text);} finally{LocalFree(text);} }
   finally{LocalFree(descriptor);}
  } finally {CloseHandle(h);}
 }
 public static int TryRestricted(string name) {
  IntPtr original=IntPtr.Zero,sid=IntPtr.Zero,restricted=IntPtr.Zero;
  if(!OpenProcessToken(GetCurrentProcess(),10,out original)) throw new Exception("Open token failed");
  try {
   if(!ConvertStringSidToSid("S-1-5-7",out sid)) throw new Exception("Parse restricted SID failed");
   SidAttributes restriction=new SidAttributes{Sid=sid,Attributes=0};
   if(!CreateRestrictedToken(original,1,0,IntPtr.Zero,0,IntPtr.Zero,1,ref restriction,out restricted)) throw new Exception("Restricted token failed "+Marshal.GetLastWin32Error());
   if(!ImpersonateLoggedOnUser(restricted)) throw new Exception("Impersonation failed");
   try { IntPtr h=CreateFile(name,0x00020000,0,IntPtr.Zero,3,0,IntPtr.Zero); if(h==new IntPtr(-1)) return Marshal.GetLastWin32Error(); CloseHandle(h); return 0; }
   finally {RevertToSelf();}
  } finally {if(restricted!=IntPtr.Zero)CloseHandle(restricted);if(sid!=IntPtr.Zero)LocalFree(sid);CloseHandle(original);}
 }
}
'@
$sddl=[PipeAclProbe]::Read('\\\\.\\pipe\\${name}')
$descriptor=New-Object Security.AccessControl.RawSecurityDescriptor($sddl)
$rules=@($descriptor.DiscretionaryAcl | ForEach-Object { $_.SecurityIdentifier.Value })
$restrictedError=[PipeAclProbe]::TryRestricted('\\\\.\\pipe\\${name}')
$remote=New-Object IO.Pipes.NamedPipeClientStream($env:COMPUTERNAME,'${name}',[IO.Pipes.PipeDirection]::InOut)
$remoteConnected=$false
$remoteError=$null
try { $remote.Connect(1500); $remoteConnected=$remote.IsConnected } catch { $remoteError=$_.Exception.Message } finally { $remote.Dispose() }
@{ sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; rules=$rules; sddl=$sddl; restrictedError=$restrictedError; remoteConnected=$remoteConnected; remoteError=$remoteError } | ConvertTo-Json -Compress
`;
  const result = await new Promise((resolve, reject) => {
    const probe = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true }); let stdout = '', stderr = '';
    probe.stdout.on('data', data => { stdout += data; }); probe.stderr.on('data', data => { stderr += data; }); probe.once('error', reject); probe.once('exit', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
  assert.deepEqual(result.rules, [result.sid]); assert.match(result.sddl, /D:P/); assert.equal(result.restrictedError, 5); assert.equal(result.remoteConnected, false);
});

test('native pipe exits on parent stdin EOF and the same endpoint can restart', { skip: !available ? 'Requires compiled Windows helper' : false }, async t => {
  const name = `MediaHub-restart-${crypto.randomUUID()}`;
  const first = spawn(helper, ['server', '--pipe', name], { windowsHide: true }); t.after(() => first.kill());
  const initial = await connectPipe(`\\\\.\\pipe\\${name}`); initial.destroy();
  const exited = new Promise(resolve => first.once('exit', resolve)); first.stdin.end();
  await Promise.race([exited, delay(5000).then(() => { throw new Error('pipe survived parent EOF'); })]);
  const second = spawn(helper, ['server', '--pipe', name], { windowsHide: true }); t.after(() => second.kill());
  const restarted = await connectPipe(`\\\\.\\pipe\\${name}`); restarted.destroy(); assert.equal(second.exitCode, null);
});
test('native owned job stops its tree after abrupt parent process exit', { skip: !available ? 'Requires compiled Windows helper' : false }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mediahub-native-owner-')); const marker = path.join(directory, 'pids.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const managedScript = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,grandchild:child.pid}));setInterval(()=>{},1000);`;
  const fixtureScript = `const fs=require('node:fs');const {spawn}=require('node:child_process');const worker=spawn(${JSON.stringify(helper)},['job','--',process.execPath,'-e',${JSON.stringify(managedScript)}],{windowsHide:true,stdio:'ignore',detached:true});worker.unref();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){process.stdout.write(JSON.stringify({...JSON.parse(fs.readFileSync(${JSON.stringify(marker)},'utf8')),supervisor:worker.pid})+'\\n');clearInterval(timer);process.exit(0)}},20);`;
  const fixture = spawn(process.execPath, ['-e', fixtureScript], { windowsHide: true });
  const pids = await new Promise((resolve, reject) => { let output = ''; fixture.once('error', reject); fixture.stdout.on('data', data => { output += data; if (output.includes('\n')) resolve(JSON.parse(output.trim())); }); });
  t.after(() => { try { process.kill(pids.supervisor); } catch {} });
  for (let attempt = 0; attempt < 200; attempt++) { let alive = false; for (const pid of [pids.pid, pids.grandchild]) { try { process.kill(pid, 0); alive = true; } catch {} } if (!alive) return; await delay(25); }
  assert.fail('owned process survived abrupt parent exit');
});
