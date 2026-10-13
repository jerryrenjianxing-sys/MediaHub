'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { UpdateController, DEFAULT_FEED } = require('../desktop/updates.cjs');
function fixture(t, version = '0.1.0-preview.1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mediahub-update-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const updater = new EventEmitter(); const calls = [];
  updater.setFeedURL = feed => calls.push(['feed', feed]);
  updater.checkForUpdates = async () => { calls.push(['check']); updater.emit('update-available', { version: '0.1.0-preview.2', files: [{ url: 'https://github.com/example/platform.exe' }] }); };
  updater.downloadUpdate = async () => { calls.push(['download']); updater.emit('download-progress', { percent: 50 }); updater.emit('update-downloaded', { version: '0.1.0-preview.2', downloadedFile: path.join(root, 'platform.exe') }); };
  updater.quitAndInstall = (...args) => calls.push(['install', ...args]);
  const controller = new UpdateController({ updater, version, dataRoot: root, beforeInstall: async () => true });
  return { root, updater, calls, controller };
}
test('startup/check never download or install, explicit actions retain the independent platform feed', async t => {
  const { controller, updater, calls, root } = fixture(t);
  assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallOnAppQuit, false); assert.equal(updater.allowDowngrade, false);
  assert.equal(calls[0][1].url, DEFAULT_FEED);
  await assert.rejects(controller.call('install'));
  await controller.call('check'); assert.equal(controller.snapshot().status, 'available'); assert.equal(calls.length, 2);
  await controller.call('download'); assert.equal(controller.snapshot().status, 'downloaded'); assert.equal(calls.length, 3);
  await controller.call('install'); assert.equal(calls[3][0], 'install');
  const journal = JSON.parse(fs.readFileSync(path.join(root, 'platform-update.json'), 'utf8'));
  assert.equal(journal.targetVersion, '0.1.0-preview.2'); assert.equal(journal.stage, 'installing');
  assert.equal(journal.downloadUrl, 'https://github.com/example/platform.exe');
});
test('upgrade is ready only after the new app reports ready, interrupted old version never replays installation', async t => {
  const { controller, updater, calls, root } = fixture(t);
  await controller.call('check'); await controller.call('download'); await controller.call('install');
  const old = new UpdateController({ updater, version: '0.1.0-preview.1', dataRoot: root, beforeInstall: async () => true });
  assert.equal(old.snapshot().lastUpgrade.stage, 'interrupted'); assert.equal(calls.filter(v => v[0] === 'install').length, 1);
  const next = new UpdateController({ updater, version: '0.1.0-preview.2', dataRoot: root, beforeInstall: async () => true });
  assert.equal(next.snapshot().lastUpgrade.stage, 'starting'); next.markReady();
  assert.equal(next.snapshot().lastUpgrade.stage, 'ready'); assert.equal(next.snapshot().lastUpgrade.loadedVersion, '0.1.0-preview.2');
  assert.equal(calls.filter(v => v[0] === 'install').length, 1);
});
