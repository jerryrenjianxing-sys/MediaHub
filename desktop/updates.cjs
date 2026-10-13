'use strict';
const { EventEmitter } = require('node:events');
const DEFAULT_FEED = 'https://raw.githubusercontent.com/jerryrenjianxing-sys/MediaHub/distribution/updates';
class UpdateController extends EventEmitter {
  constructor({ updater, version, beforeInstall, feed = DEFAULT_FEED }) {
    super(); this.updater = updater; this.beforeInstall = beforeInstall;
    this.state = { status: 'idle', currentVersion: version, availableVersion: null, percent: 0, error: null, checkedAt: null };
    updater.autoDownload = false; updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = true; updater.allowDowngrade = false;
    updater.channel = 'preview'; updater.disableWebInstaller = true;
    updater.setFeedURL({ provider: 'generic', url: feed, channel: 'preview' });
    updater.on('checking-for-update', () => this.patch({ status: 'checking', error: null }));
    updater.on('update-available', info => this.patch({ status: 'available', availableVersion: info.version, checkedAt: new Date().toISOString() }));
    updater.on('update-not-available', () => this.patch({ status: 'current', checkedAt: new Date().toISOString() }));
    updater.on('download-progress', p => this.patch({ status: 'downloading', percent: p.percent }));
    updater.on('update-downloaded', info => this.patch({ status: 'downloaded', availableVersion: info.version, percent: 100 }));
    updater.on('error', error => this.patch({ status: 'failed', error: error.message }));
  }
  patch(value) { Object.assign(this.state, value); this.emit('changed', this.snapshot()); }
  snapshot() { return structuredClone(this.state); }
  async call(action) {
    if (action === 'check') { await this.updater.checkForUpdates(); return this.snapshot(); }
    if (action === 'download') {
      if (this.state.status !== 'available') throw new Error('请先检查到可用的平台更新');
      this.patch({ status: 'downloading', percent: 0, error: null }); await this.updater.downloadUpdate(); return this.snapshot();
    }
    if (action === 'install') {
      if (this.state.status !== 'downloaded') throw new Error('平台更新尚未下载完成');
      if (!await this.beforeInstall()) return this.snapshot();
      this.patch({ status: 'installing' }); this.updater.quitAndInstall(false, true); return this.snapshot();
    }
    if (action === 'dismiss') return this.snapshot();
    throw new Error('未知的平台更新操作');
  }
}
module.exports = { UpdateController, DEFAULT_FEED };
