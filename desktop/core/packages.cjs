'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { fault, ensureDir, assertWithin, sha256 } = require('./files.cjs');

function request(url, signal, redirects = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return reject(fault('UNSAFE_DOWNLOAD', '只允许 HTTPS 下载'));
    const req = https.get(parsed, { signal, headers: { 'User-Agent': 'MediaHub/0.1', Accept: 'application/octet-stream' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (redirects >= 5 || !res.headers.location) return reject(fault('DOWNLOAD_REDIRECT', '下载重定向次数超限'));
        request(new URL(res.headers.location, parsed).href, signal, redirects + 1).then(resolve, reject);
      } else if (res.statusCode === 200) resolve(res);
      else { res.resume(); reject(fault('DOWNLOAD_HTTP', `下载失败 (${res.statusCode})`)); }
    });
    req.setTimeout(60000, () => req.destroy(fault('DOWNLOAD_TIMEOUT', '下载连接超时')));
    req.on('error', reject);
  });
}
async function downloadVerified(pkg, target, { signal, progress = () => {} } = {}) {
  signal?.throwIfAborted();
  ensureDir(path.dirname(target));
  if (fs.existsSync(target) && fs.statSync(target).size === pkg.bytes && await sha256(target) === pkg.sha256) return target;
  const partial = `${target}.${crypto.randomUUID()}.partial`;
  try {
    const res = await request(pkg.url, signal);
    let received = 0;
    const counter = new Transform({ transform(chunk, encoding, done) {
      received += chunk.length;
      if (received > pkg.bytes) return done(fault('DOWNLOAD_SIZE', '下载内容超过声明大小'));
      progress({ phase: 'downloading', percent: Math.round(received / pkg.bytes * 100), receivedBytes: received, totalBytes: pkg.bytes }); done(null, chunk);
    } });
    await pipeline(res, counter, fs.createWriteStream(partial, { flags: 'wx' }), { signal });
    if (received !== pkg.bytes) throw fault('DOWNLOAD_SIZE', '下载内容大小不符');
    progress({ phase: 'verifying', percent: 100 });
    if (await sha256(partial) !== pkg.sha256) throw fault('CHECKSUM_MISMATCH', '下载内容校验失败');
    fs.renameSync(partial, target); return target;
  } finally { if (fs.existsSync(partial)) fs.unlinkSync(partial); }
}
async function extractZip(file, root, { signal, maxBytes = 8 * 1024 ** 3 } = {}) {
  const yauzl = require('yauzl');
  ensureDir(root);
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (openError, zip) => {
      if (openError) return reject(openError);
      let total = 0; let entries = 0; let settled = false;
      const fail = e => { if (!settled) { settled = true; zip.close(); reject(e); } };
      const cancelled = () => fail(fault('CANCELLED', '操作已取消'));
      signal?.addEventListener('abort', cancelled, { once: true });
      zip.on('error', fail);
      zip.on('end', () => { signal?.removeEventListener('abort', cancelled); if (!settled) { settled = true; resolve(); } });
      zip.on('entry', async entry => {
        try {
          if (signal?.aborted) throw fault('CANCELLED', '操作已取消');
          const name = entry.fileName;
          if (++entries > 100000 || name.includes('\\') || name.split('/').some(s => s === '..' || /^[a-zA-Z]:/.test(s) || /[:\x00-\x1f]/.test(s) || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)) || name.startsWith('/') || (entry.externalFileAttributes >>> 16 & 0o170000) === 0o120000) throw fault('UNSAFE_ARCHIVE', '压缩包含危险路径');
          total += entry.uncompressedSize;
          if (total > maxBytes) throw fault('ARCHIVE_SIZE', '压缩包解压大小超限');
          const target = assertWithin(root, path.join(root, name));
          if (name.endsWith('/')) { ensureDir(target); zip.readEntry(); return; }
          ensureDir(path.dirname(target));
          const stream = await new Promise((res, rej) => zip.openReadStream(entry, (e, s) => e ? rej(e) : res(s)));
          await pipeline(stream, fs.createWriteStream(target, { flags: 'wx' }), { signal });
          zip.readEntry();
        } catch (e) { fail(e); }
      });
      zip.readEntry();
    });
  });
}
module.exports = { request, downloadVerified, extractZip };
