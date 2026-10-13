'use strict';
const fs = require('node:fs');
const path = require('node:path');
module.exports = async context => {
  const resources = path.join(context.appOutDir, 'resources');
  const forbidden = ['tools', 'components', 'runtime', 'node.exe', 'chrome-headless-shell.exe', 'ffmpeg.exe', 'ffprobe.exe'];
  for (const name of forbidden) if (fs.existsSync(path.join(resources, name))) throw new Error(`Platform unexpectedly contains a tool payload: ${name}`);
  const { listPackage } = require('@electron/asar');
  const files = listPackage(path.join(resources, 'app.asar'));
  if (files.some(file => /(?:^|\/)tools\/hyperframes|(?:^|\/)runtime\/|ffmpeg\.exe|chrome-headless-shell/.test(file.replace(/\\/g, '/')))) throw new Error('Tool runtime included in app.asar');
  for (const file of ['native/mediahub-pipe.exe', 'resources/catalog.json', 'resources/catalog-public.pem']) if (!fs.existsSync(path.join(resources, file))) throw new Error(`Required host resource missing: ${file}`);
  fs.writeFileSync(path.join(context.outDir, 'platform-payload.json'), JSON.stringify({ schema: 1, version: context.packager.appInfo.version, baseContainsToolPayload: false, verifiedAt: new Date().toISOString(), resourceFiles: fs.readdirSync(resources), asarFiles: files.length }, null, 2));
};
