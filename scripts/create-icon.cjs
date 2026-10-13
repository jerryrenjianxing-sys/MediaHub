'use strict';
// Export the canonical vector to Windows icons. Supply MEDIAHUB_SHARP_MODULE
// when using a bundled graphics runtime; it is a build utility, not app payload.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require(process.env.MEDIAHUB_SHARP_MODULE || 'sharp');
const root = path.resolve(__dirname, '..');
async function main() {
  const source = fs.readFileSync(path.join(root, 'branding/mediahub-mark.svg'));
  fs.writeFileSync(path.join(root, 'public/favicon.svg'), source);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = [];
  for (const size of sizes) images.push(await sharp(source, { density: 384 }).resize(size, size).png().toBuffer());
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (let index = 0; index < sizes.length; index++) {
    const entry = 6 + 16 * index;
    header[entry] = sizes[index] === 256 ? 0 : sizes[index];
    header[entry + 1] = header[entry];
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[index].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  }
  fs.writeFileSync(path.join(root, 'resources/mediahub.ico'), Buffer.concat([header, ...images]));
  const output = path.join(root, 'work', 'branding'); fs.mkdirSync(output, { recursive: true });
  await sharp(source, { density: 768 }).resize(512, 512).png().toFile(path.join(output, 'mediahub-mark.png'));
  console.log('MediaHub favicon and seven Windows icon sizes exported.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
