'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function fault(code, message) { return Object.assign(new Error(message), { code }); }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT' && arguments.length > 1) return fallback; throw e; } }
function atomicJson(file, value) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try { fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function assertWithin(root, candidate) { if (!within(root, candidate)) throw fault('UNSAFE_PATH', '路径超出指定目录'); return path.resolve(candidate); }
function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function safeName(value) { return String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 100) || 'untitled'; }
function sha256(file) { return new Promise((resolve, reject) => { const h = crypto.createHash('sha256'); const s = fs.createReadStream(file); s.on('error', reject); s.on('data', b => h.update(b)); s.on('end', () => resolve(h.digest('hex'))); }); }
function nonSymlink(file) { if (fs.lstatSync(file).isSymbolicLink()) throw fault('UNSAFE_PATH', '不允许使用符号链接'); return fs.realpathSync(file); }
module.exports = { fault, ensureDir, readJson, atomicJson, within, assertWithin, id, safeName, sha256, nonSymlink };
