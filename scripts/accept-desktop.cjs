'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const reportRoot = path.join(root, 'work', 'desktop-acceptance');
fs.mkdirSync(reportRoot, { recursive: true });
const profilePath = path.join(reportRoot, 'profile.json');
fs.writeFileSync(profilePath, JSON.stringify({ acceptance: true, dataRoot: path.join(reportRoot, 'data'), workspaceRoot: path.join(reportRoot, '共享 工作空间') }, null, 2));
const executable = process.env.MEDIAHUB_ACCEPTANCE_EXE || path.join(root, 'node_modules/electron/dist/electron.exe');
const port = Number(process.env.MEDIAHUB_ACCEPTANCE_PORT || 9446);
const args = process.env.MEDIAHUB_ACCEPTANCE_EXE ? [] : [root];
args.push('--mediahub-profile', profilePath, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1');
if (process.env.MEDIAHUB_ACCEPTANCE_SCALE) args.push(`--force-device-scale-factor=${Number(process.env.MEDIAHUB_ACCEPTANCE_SCALE)}`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const log = fs.createWriteStream(path.join(reportRoot, 'electron-output.log'));
const child = spawn(executable, args, { cwd: root, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(log); child.stderr.pipe(log);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const { chromium } = require(process.env.MEDIAHUB_PLAYWRIGHT_MODULE || 'playwright');
  let connected = false;
  for (let attempt = 0; attempt < 150; attempt++) { try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); if (response.ok) { connected = true; break; } } catch {} await wait(200); }
  assert.ok(connected, 'Acceptance app exposes no debugging endpoint');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  let page;
  for (let attempt = 0; attempt < 150; attempt++) { page = context.pages().find(p => p.url().startsWith('mediahub://app/')); if (page) break; await wait(200); }
  assert.ok(page, 'Trusted platform page missing');
  await page.waitForFunction(() => !!window.mediaHub, { timeout: 20000 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const snapshot = await page.evaluate(() => window.mediaHub.call('platform.snapshot'));
  const observedWindow = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio }));
  assert.equal(snapshot.tools.length, 4); assert.ok(snapshot.tools.every(t => t.status === 'not-installed'));
  assert.equal(fs.readdirSync(path.join(reportRoot, 'data', 'downloads')).length, 0);
  assert.ok(snapshot.workspace.path.startsWith(reportRoot));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await page.getByRole('button', { name: '连接 Agent', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.screenshot({ path: path.join(reportRoot, 'home-dark.png') });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '浅色', exact: true }).click();
  await page.getByRole('button', { name: '连接 Agent', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.screenshot({ path: path.join(reportRoot, 'home-light.png') });
  for (const name of ['工具', '项目', '素材与成果', '安装与更新', '设置']) {
    await page.getByRole('button', { name, exact: true }).first().click();
    await page.screenshot({ path: path.join(reportRoot, `${name}.png`) });
  }
  const project = await page.evaluate(() => window.mediaHub.call('projects.create', { name: '验收 中文与空格', orientation: 'portrait' }));
  assert.equal(project.orientation, 'portrait'); assert.ok(fs.existsSync(path.join(project.path, 'project.json')));
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: path.join(reportRoot, 'small-layout.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, 'Horizontal overflow');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(reportRoot, 'result.json'), JSON.stringify({ version: snapshot.version, passed: true, baseDownloads: 0, tools: snapshot.tools.map(t => ({ id: t.id, state: t.status })), screenshots: 8, observedWindow, narrowContentViewport: { width: 1024, height: 768 }, appScaleOverride: process.env.MEDIAHUB_ACCEPTANCE_SCALE || null, connectionAvailable: snapshot.connection.available, profile: 'acceptance', tests: ['shared workspace', 'four uninstalled tools', 'empty downloads', 'themes', 'navigation', 'Chinese/spaces', 'no renderer Node', 'no page errors'], completedAt: new Date().toISOString() }, null, 2));
  await page.evaluate(() => window.mediaHub.call('platform.quit')).catch(error => { if (!/closed|destroyed/i.test(error.message)) throw error; });
  await browser.close().catch(() => {});
}
main().catch(error => { fs.writeFileSync(path.join(reportRoot, 'failure.txt'), error.stack); child.kill(); console.error(error.stack); process.exitCode = 1; });
