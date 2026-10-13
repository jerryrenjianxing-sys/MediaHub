'use strict';
const crypto = require('node:crypto');
const { fault } = require('./files.cjs');

const ID = /^[a-z][a-z0-9-]{0,63}$/;
function validateCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.tools) || catalog.tools.length > 100) throw fault('INVALID_CATALOG', '工具目录格式无效');
  const ids = new Set();
  for (const tool of catalog.tools) {
    if (!ID.test(tool.id) || ids.has(tool.id) || !['external', 'component'].includes(tool.kind)) throw fault('INVALID_CATALOG', '工具标识或类型无效');
    ids.add(tool.id);
    if (tool.package) {
      if (!/^https:\/\//.test(tool.package.url) || !/^[a-f0-9]{64}$/i.test(tool.package.sha256) || !Number.isSafeInteger(tool.package.bytes) || tool.package.bytes < 1) throw fault('INVALID_CATALOG', '组件必须具有 HTTPS 下载地址、大小与 SHA256');
      if (!/^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,80}$/.test(tool.version || '')) throw fault('INVALID_CATALOG', '组件版本无效');
    }
    if (tool.install && (!/^https:\/\//.test(tool.install.url || '') || !/^[a-f0-9]{64}$/i.test(tool.install.sha256 || '') || !Number.isSafeInteger(tool.install.bytes) || tool.install.bytes < 1 || typeof tool.install.fileName !== 'string' || /[\\/:\x00-\x1f]/.test(tool.install.fileName) || tool.install.fileName.length > 200)) throw fault('INVALID_CATALOG', '原软件安装包信息无效');
  }
  return catalog;
}
function verifyEnvelope(envelope, publicKey) {
  if (!publicKey || envelope?.algorithm !== 'Ed25519' || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw fault('INVALID_SIGNATURE', '缺少可信目录签名');
  const payload = Buffer.from(envelope.payload, 'base64');
  const signature = Buffer.from(envelope.signature, 'base64');
  const key = crypto.createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || !payload.length || payload.length > 1024 * 1024 || signature.length !== 64 || !crypto.verify(null, payload, key, signature)) throw fault('INVALID_SIGNATURE', '工具目录签名验证失败');
  return validateCatalog(JSON.parse(payload.toString('utf8')));
}
module.exports = { validateCatalog, verifyEnvelope };
