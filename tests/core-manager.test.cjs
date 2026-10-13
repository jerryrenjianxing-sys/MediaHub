'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const https = require('node:https');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { createManager, DEFAULT_TOOLS } = require('../desktop/core/manager.cjs');
const { verifyEnvelope } = require('../desktop/core/catalog.cjs');
const { extractZip, downloadVerified } = require('../desktop/core/packages.cjs');

async function terminal(manager, taskId) {
  for (let attempts = 0; attempts < 300; attempts++) {
    const task = await manager.call('tasks.get', { taskId });
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(task.state)) return task;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('task did not terminate');
}
function isolated(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mediahub-core-'));
  const manager = createManager({ dataRoot: path.join(root, 'platform'), workspacePath: path.join(root, '中文 空格 workspace'), acceptance: true, ...overrides });
  t.after(async () => { await manager.close({ cancel: true }); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, manager };
}
function zipFile(entries) {
  const bodies = [], central = []; let offset = 0;
  const crc32 = data => { let crc = 0xffffffff; for (const b of data) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name), content = Buffer.from(value), crc = crc32(content);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt32LE(crc, 16); header.writeUInt32LE(content.length, 20); header.writeUInt32LE(content.length, 24); header.writeUInt16LE(nameBytes.length, 28); header.writeUInt32LE(offset, 42);
    bodies.push(local, nameBytes, content); central.push(header, nameBytes); offset += local.length + nameBytes.length + content.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...bodies, directory, end]);
}

test('empty platform has no payload, creates isolated workspace and copies assets without overwriting originals', async t => {
  const { root, manager } = isolated(t); await manager.ready;
  assert.equal(manager.snapshot().tools.length, 4);
  assert.ok(manager.snapshot().tools.every(tool => tool.status === 'not-installed'));
  assert.equal(fs.readdirSync(path.join(root, 'platform', 'downloads')).length, 0);
  const project = await manager.call('projects.create', { name: '中文 项目', orientation: 'portrait' });
  const source = path.join(root, '原素材.txt'); fs.writeFileSync(source, 'original');
  const asset = await manager.call('assets.import', { path: source, projectId: project.id });
  fs.writeFileSync(source, 'changed'); assert.equal(fs.readFileSync(asset.path, 'utf8'), 'original');
  const output = path.join(project.path, 'result.txt'); fs.writeFileSync(output, 'result');
  const artifact = await manager.call('artifacts.register', { projectId: project.id, path: output });
  assert.ok(artifact.id); assert.equal(manager.snapshot().artifacts.length, 1);
  await assert.rejects(manager.call('artifacts.register', { projectId: project.id, path: source }), { code: 'INVALID_PATH' });
  await assert.rejects(manager.call('workspace.set', { path: path.join(root, 'platform', 'components', 'bad') }), { code: 'INVALID_PATH' });
  await assert.rejects(manager.call('workspace.set', { path: path.join(root, 'platform', 'desktop') }), { code: 'INVALID_PATH' });
  await assert.rejects(manager.call('workspace.set', { path: root }), { code: 'INVALID_PATH' });
  await assert.rejects(manager.call('artifacts.register', { projectId: project.id, path: output, toolId: 'hyperframes', mediaValidated: true }), { code: 'MEDIA_NOT_VALIDATED' });
});

test('workspace stays outside the packaged program and stopping a component does not overwrite an installation state', async t => {
  const programRoot = path.join(os.tmpdir(), 'MediaHub packaged ' + crypto.randomUUID());
  const { manager } = isolated(t, { programRoot, externalRecords: [{ id: 'hyperframes', status: 'installed', version: '1.0.0' }] });
  await manager.ready;
  await assert.rejects(manager.call('workspace.set', { path: path.join(programRoot, 'project') }), { code: 'INVALID_PATH' });
  const before = (await manager.call('tools.status', { toolId: 'hyperframes' })).status;
  manager.componentStopped('hyperframes');
  assert.equal((await manager.call('tools.status', { toolId: 'hyperframes' })).status, before);
});

test('external management opens original entry and never deletes its data', async t => {
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'mediahub-external-')); const original = path.join(external, 'database.json'); fs.writeFileSync(original, 'keep');
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  const actions = [];
  const { manager } = isolated(t, { externalRecords: [{ id: 'mediaflow', installPath: 'C:/fake/MediaFlow.exe', version: '1.2.3', dataPaths: [external] }], onOpenExternalTool: async (_tool, _installed, intent) => actions.push(intent?.action || 'open') });
  await manager.ready;
  const uninstall = await manager.call('tools.uninstallEntry', { toolId: 'mediaflow' });
  assert.equal(uninstall.managedBy, 'original'); assert.equal(fs.readFileSync(original, 'utf8'), 'keep');
  assert.equal((await manager.call('tools.status', { toolId: 'mediaflow' })).status, 'installed'); assert.deepEqual(actions, ['uninstall']);
});

test('signed catalog authenticates exact bytes and refuses a changed download', () => {
  const keys = crypto.generateKeyPairSync('ed25519'); const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, tools: DEFAULT_TOOLS }));
  const envelope = { algorithm: 'Ed25519', payload: bytes.toString('base64'), signature: crypto.sign(null, bytes, keys.privateKey).toString('base64') };
  assert.equal(verifyEnvelope(envelope, keys.publicKey.export({ type: 'spki', format: 'pem' })).tools.length, 4);
  assert.throws(() => verifyEnvelope({ ...envelope, payload: Buffer.from('{"tools":[]}').toString('base64') }, keys.publicKey.export({ type: 'spki', format: 'pem' })), { code: 'INVALID_SIGNATURE' });
});

test('streaming ZIP rejects traversal and extracts valid files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mediahub-zip-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bad = path.join(root, 'bad.zip'); fs.writeFileSync(bad, zipFile([['../escape.txt', 'escape']]));
  await assert.rejects(extractZip(bad, path.join(root, 'bad'))); assert.equal(fs.existsSync(path.join(root, 'escape.txt')), false);
  const valid = path.join(root, 'valid.zip'); fs.writeFileSync(valid, zipFile([['assets/logo.txt', 'logo']]));
  await extractZip(valid, path.join(root, 'valid')); assert.equal(fs.readFileSync(path.join(root, 'valid', 'assets', 'logo.txt'), 'utf8'), 'logo');
});

test('component installs atomically, rollback retains old version and uninstall preserves workspace', async t => {
  const { root, manager } = isolated(t);
  await manager.ready;
  const stageRelease = version => {
    const zip = zipFile([['manifest.json', JSON.stringify({ id: 'hyperframes', version })], ['payload.txt', version]]); const hash = crypto.createHash('sha256').update(zip).digest('hex');
    const release = { id: 'hyperframes', name: 'HyperFrames', kind: 'component', version, package: { url: 'https://example.com/tool.zip', sha256: hash, bytes: zip.length } };
    fs.writeFileSync(path.join(root, 'platform', 'downloads', `hyperframes-${version}-${hash.slice(0, 12)}.zip`), zip);
    return release;
  };
  const one = stageRelease('1.0.0');
  // Independent profiles with a trusted bundled catalog exercise the installation transaction.
  await manager.close();
  const first = createManager({ dataRoot: path.join(root, 'platform'), acceptance: true, workspacePath: path.join(root, '中文 空格 workspace'), catalog: { tools: [one] }, onComponentHealth: async () => {} });
  await first.ready; const project = await first.call('projects.create', { name: 'keep project' });
  assert.equal((await terminal(first, (await first.call('tools.install', { toolId: 'hyperframes' })).id)).state, 'completed');
  await first.close();
  const two = stageRelease('2.0.0');
  const second = createManager({ dataRoot: path.join(root, 'platform'), acceptance: true, workspacePath: path.join(root, '中文 空格 workspace'), catalog: { tools: [two] }, onComponentHealth: async (_id, details) => { if (details.version === '2.0.0') throw new Error('health failure'); } });
  t.after(() => second.close()); await second.ready;
  assert.equal((await terminal(second, (await second.call('tools.install', { toolId: 'hyperframes' })).id)).state, 'failed');
  assert.equal((await second.call('tools.status', { toolId: 'hyperframes' })).installedVersion, '1.0.0');
  await second.call('tools.uninstallEntry', { toolId: 'hyperframes' }); assert.ok(fs.existsSync(path.join(project.path, 'project.json')));
  await second.close();
});

test('task cancellation reports cancelling until real adapter acknowledges shutdown', async t => {
  let release;
  const { root, manager } = isolated(t); await manager.ready; await manager.close();
  const component = path.join(root, 'platform', 'components', 'hyperframes', 'versions', '1.0.0'); fs.mkdirSync(component, { recursive: true }); fs.writeFileSync(path.join(component, 'manifest.json'), JSON.stringify({ id: 'hyperframes', version: '1.0.0' })); fs.writeFileSync(path.join(root, 'platform', 'components', 'hyperframes', 'active.json'), JSON.stringify({ version: '1.0.0', path: component }));
  const live = createManager({ dataRoot: path.join(root, 'platform'), acceptance: true, workspacePath: path.join(root, 'workspace'), onInvokeHyperframes: async (_action, _args, ctx) => { await new Promise(resolve => { release = resolve; }); if (ctx.signal.aborted) throw Object.assign(new Error('shutdown confirmed'), { code: 'CANCELLED' }); return {}; } });
  t.after(() => live.close({ cancel: true })); await live.ready;
  const project = await live.call('projects.create', { name: 'cancel' }); const task = await live.call('capabilities.invoke', { capabilityId: 'hyperframes.check', projectId: project.id });
  await new Promise(resolve => setTimeout(resolve, 20));
  const cancelled = await live.call('tasks.cancel', { taskId: task.id }); assert.equal(cancelled.state, 'cancelling');
  release(); assert.equal((await terminal(live, task.id)).state, 'cancelled'); await live.close();
});

test('restart marks uncertain work interrupted without replay and filters forged workspace paths', async t => {
  const { root, manager } = isolated(t); await manager.ready;
  const project = await manager.call('projects.create', { name: 'recovery' });
  await manager.close();
  const db = new DatabaseSync(path.join(root, 'platform', 'platform.sqlite'));
  const task = { id: 'task_recover', toolId: 'hyperframes', capabilityId: 'hyperframes.render', projectId: project.id, state: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  db.prepare('INSERT INTO records(kind,id,json) VALUES(?,?,?)').run('tasks', task.id, JSON.stringify(task)); db.close();
  const external = path.join(root, 'unrelated-secret.txt'); fs.writeFileSync(external, 'unrelated');
  fs.writeFileSync(path.join(project.path, 'artifacts.json'), JSON.stringify([{ id: 'artifact_forged', projectId: project.id, path: external }]));
  let invocations = 0;
  const recovered = createManager({ dataRoot: path.join(root, 'platform'), workspacePath: path.join(root, '中文 空格 workspace'), acceptance: true, onInvokeHyperframes: async () => { invocations++; } });
  t.after(() => recovered.close()); await recovered.ready;
  assert.equal((await recovered.call('tasks.get', { taskId: task.id })).state, 'interrupted'); assert.equal(invocations, 0);
  assert.deepEqual(await recovered.call('artifacts.list'), []); assert.equal(fs.readFileSync(external, 'utf8'), 'unrelated'); await recovered.close();
});

test('download rejects a changed body and repairs a corrupt cache using verified bytes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mediahub-download-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const body = Buffer.from('verified payload'), checksum = crypto.createHash('sha256').update(body).digest('hex');
  let served = Buffer.from('tampered payload');
  const original = https.get;
  https.get = (_url, _options, callback) => {
    const req = new EventEmitter(); req.setTimeout = () => req;
    process.nextTick(() => { const response = Readable.from([served]); response.statusCode = 200; callback(response); }); return req;
  };
  t.after(() => { https.get = original; });
  const target = path.join(root, 'package.zip'); const pkg = { url: 'https://example.invalid/package.zip', sha256: checksum, bytes: body.length };
  await assert.rejects(downloadVerified(pkg, target), { code: 'CHECKSUM_MISMATCH' });
  assert.deepEqual(fs.readdirSync(root), []);
  fs.writeFileSync(target, 'corrupt cache'); served = body;
  await downloadVerified(pkg, target); assert.deepEqual(fs.readFileSync(target), body);
});
