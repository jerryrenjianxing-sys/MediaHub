'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { verifyEnvelope } = require('../desktop/core/catalog.cjs');
const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2); const options = {};
for (let i = 0; i < argv.length; i += 2) { if (!argv[i].startsWith('--') || !argv[i + 1]) throw new Error('Expected --name value'); options[argv[i].slice(2)] = argv[i + 1]; }
const output = path.resolve(options.output || path.join(root, 'work', 'distribution-stage'));
if (output === root || output.startsWith(path.join(root, '.publisher'))) throw new Error('Unsafe output directory');
const releaseRoot = 'https://github.com/jerryrenjianxing-sys/MediaHub/releases/download/';
function version(value) { if (!/^0\.1\.0-preview\.[1-9]\d*$/.test(value)) throw new Error('Expected immutable preview version'); return value; }
function digest(file, algorithm) { return crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(algorithm === 'sha512' ? 'base64' : 'hex'); }
fs.mkdirSync(output, { recursive: true });
const receipt = { schema: 1, generatedAt: new Date().toISOString() };
if (options.component) {
  const componentVersion = version(options['component-version']); const file = path.resolve(options.component);
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'resources/catalog.json'), 'utf8'));
  const hf = catalog.tools.find(t => t.id === 'hyperframes');
  hf.version = componentVersion;
  hf.package = { url: releaseRoot + 'hyperframes-v' + componentVersion + '/' + encodeURIComponent(path.basename(file)), fileName: path.basename(file), sha256: digest(file, 'sha256'), bytes: fs.statSync(file).size };
  catalog.generatedAt = new Date().toISOString(); catalog.sequence = Date.now();
  const previous = path.join(output, 'catalog/catalog.signed.json');
  if (fs.existsSync(previous)) { const before = verifyEnvelope(JSON.parse(fs.readFileSync(previous, 'utf8')), fs.readFileSync(path.join(root, 'resources/catalog-public.pem'), 'utf8')); catalog.sequence = Math.max(catalog.sequence, before.sequence + 1); }
  const input = path.join(root, 'work', 'catalog-input.json'); fs.mkdirSync(path.dirname(input), { recursive: true }); fs.writeFileSync(input, JSON.stringify(catalog, null, 2));
  execFileSync(process.execPath, [path.join(root, 'scripts/sign-catalog.cjs'), input, previous], { stdio: 'pipe' });
  const verified = verifyEnvelope(JSON.parse(fs.readFileSync(previous, 'utf8')), fs.readFileSync(path.join(root, 'resources/catalog-public.pem'), 'utf8'));
  receipt.component = { version: componentVersion, sequence: verified.sequence, ...hf.package };
}
if (options.installer) {
  const platformVersion = version(options['platform-version']); const file = path.resolve(options.installer); const checksum = digest(file, 'sha512');
  const url = releaseRoot + 'v' + platformVersion + '/' + encodeURIComponent(path.basename(file));
  const directory = path.join(output, 'updates'); fs.mkdirSync(directory, { recursive: true });
  const yaml = `version: ${platformVersion}\nfiles:\n  - url: ${url}\n    sha512: ${checksum}\n    size: ${fs.statSync(file).size}\npath: ${url}\nsha512: ${checksum}\nreleaseDate: '${new Date().toISOString()}'\n`;
  fs.writeFileSync(path.join(directory, 'preview.yml'), yaml);
  receipt.platform = { version: platformVersion, url, sha256: digest(file, 'sha256'), sha512: checksum, bytes: fs.statSync(file).size };
}
if (!receipt.component && !receipt.platform) throw new Error('Supply a component or installer');
fs.writeFileSync(path.join(output, 'README.md'), '# MediaHub distribution\n\nSigned tool catalog and independent platform preview update feed. Binary assets live in immutable GitHub Releases.\n');
fs.writeFileSync(path.join(root, 'work', 'distribution-receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
