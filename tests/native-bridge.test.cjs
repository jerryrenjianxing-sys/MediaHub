'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
  readline.createInterface({ input: server.stdout }).on('line', line => { const envelope = JSON.parse(line); server.stdin.write(JSON.stringify({ transportId: envelope.transportId, response: { ok: true, result: envelope.request } }) + '\n'); });
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
