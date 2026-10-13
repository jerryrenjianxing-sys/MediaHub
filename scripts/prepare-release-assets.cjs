'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const options = {}; const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) { if (!args[i]?.startsWith('--') || !args[i + 1]) throw new Error('Expected --name value'); options[args[i].slice(2)] = args[i + 1]; }
const kind = options.kind; const version = options.version;
if (!['platform', 'hyperframes'].includes(kind) || !/^0\.1\.0-preview\.[1-9]\d*$/.test(version || '')) throw new Error('Use --kind platform|hyperframes --version 0.1.0-preview.N');
const tag = (kind === 'platform' ? 'v' : 'hyperframes-v') + version;
const output = path.join(root, 'work', 'publish', tag); fs.mkdirSync(output, { recursive: true });
const names = kind === 'platform' ? [`MediaHub-${version}-win-x64-Setup.exe`, `MediaHub-${version}-win-x64-Setup.exe.blockmap`, `MediaHub-${version}-Windows-x64.zip`, 'platform-payload.json'] : [`MediaHub-HyperFrames-${version}-win-x64.zip`, `HyperFrames-${version}.manifest.json`, `HyperFrames-${version}.sources.json`];
for (const name of names) fs.copyFileSync(path.join(root, 'release', name), path.join(output, name));
if (kind === 'hyperframes') for (const name of ['mediahub-ffmpeg-8.1.1-source.zip', 'mediahub-ffmpeg-8.1.1-windows-x64.zip']) fs.copyFileSync(path.join(root, 'work/ffmpeg-ci/latest', name), path.join(output, name));
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(root, name), path.join(output, name === 'LICENSE' ? 'LICENSE.txt' : name));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
execFileSync('git', ['archive', '--format=zip', `--output=${path.join(output, `MediaHub-${version}-source.zip`)}`, commit], { cwd: root });
const sourceReport = options.acceptance ? path.resolve(options.acceptance) : null;
const acceptance = sourceReport ? JSON.parse(fs.readFileSync(sourceReport, 'utf8')) : { schema: 1, stage: 'initial-preview', sourceCommit: commit, version, kind, completed: ['Core manager and host protocol tests', 'Windows native ACL, framing and process tree tests', 'True HyperFrames Producer render and cancellation tests'], pending: ['Public GitHub platform upgrade', 'Public GitHub component upgrade', 'Clean VM network-isolated HyperFrames workflow', 'Clean VM original installer aggregate'] };
fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(acceptance, null, 2));
const assets = [];
for (const name of fs.readdirSync(output).filter(n => !['SHA256SUMS.txt', 'release-manifest.json', 'release-notes.md'].includes(n)).sort()) { const file = path.join(output, name); if (!fs.statSync(file).isFile()) continue; assets.push({ name, bytes: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }); }
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), assets.map(a => `${a.sha256}  ${a.name}`).join('\n') + '\n');
fs.writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify({ schema: 1, tag, version, kind, sourceCommit: commit, unsigned: true, platformIncludesToolPayloads: false, assets }, null, 2));
const text = kind === 'platform' ? `Windows x64 未签名测试版。平台不携带四套工具，安装后按需下载。\n\n本轮提供平台骨架、工具管理、共享项目/素材/成果和统一 Agent 入口。旧三款工具继续独立运行与发行，更新及卸载由原软件管理；HyperFrames 使用独立组件完整管理。\n\n下载安装器或 ZIP，逐项 SHA256 见附件。此版为真实升级验收的起始版本；完整验收记录随后续预览版发布。` : `MediaHub HyperFrames 独立本地工具包，安装平台后按需下载。\n\n固定 HyperFrames 0.8.151、Node 24.21.0、Chrome headless shell 152.0.7977.30、FFmpeg / FFprobe 8.1.1，含本地 GSAP 与中文字体。创建、预览、检查和 1080p/30fps SDR MP4 导出使用本地运行文件。每次渲染独立受管进程组，取消等待真实停止；卸载保留工程。\n\nStudio 提供源文件编辑、预览及导出。包内含逐文件哈希、许可和 FFmpeg 完整对应源码；配套 FFmpeg 二进制与源码也单独附上。当前功能验收及后续流程状态见 acceptance.json。`;
fs.writeFileSync(path.join(output, 'release-notes.md'), text + '\n');
console.log(JSON.stringify({ output, tag, sourceCommit: commit, assets: assets.map(a => ({ name: a.name, bytes: a.bytes, sha256: a.sha256 })) }));
