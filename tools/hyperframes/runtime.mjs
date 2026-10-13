import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const componentRoot = path.dirname(fileURLToPath(import.meta.url));
export const versions = Object.freeze({ tool: JSON.parse(readFileSync(path.join(componentRoot, 'package.json'), 'utf8')).version, hyperframes: '0.8.151', node: '24.21.0', chrome: '152.0.7977.30', ffmpeg: '8.1.1', gsap: '3.14.2' });
export function runtimePaths(root = componentRoot) {
  const runtime = existsSync(path.join(root, 'runtime')) ? path.join(root, 'runtime') : path.join(root, 'stage', 'runtime');
  return { root: runtime, node: path.join(runtime, 'node', 'node.exe'), chrome: path.join(runtime, 'chrome', 'chrome-headless-shell.exe'), ffmpeg: path.join(runtime, 'ffmpeg', 'ffmpeg.exe'), ffprobe: path.join(runtime, 'ffmpeg', 'ffprobe.exe'), font: path.join(runtime, 'fonts', 'NotoSansSC.ttf') };
}
export function applyRuntimeEnvironment(runtime = runtimePaths()) {
  Object.assign(process.env, { HYPERFRAMES_SKIP_SKILLS: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1', HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', HYPERFRAMES_FFMPEG_PATH: runtime.ffmpeg, HYPERFRAMES_FFPROBE_PATH: runtime.ffprobe, PUPPETEER_EXECUTABLE_PATH: runtime.chrome, PRODUCER_CHROME_PATH: runtime.chrome, PRODUCER_BROWSER_GPU_MODE: 'software', PRODUCER_FORCE_SCREENSHOT: 'true', HF_AUTO_PROXY: 'false' });
  // All paths are explicit. PATH is private to this sidecar and never changes the host environment.
  process.env.PATH = [path.dirname(runtime.node), path.dirname(runtime.ffmpeg), process.env.SystemRoot && path.join(process.env.SystemRoot, 'System32')].filter(Boolean).join(path.delimiter);
  return runtime;
}
export function assertRuntime(runtime = runtimePaths()) {
  for (const key of ['node', 'chrome', 'ffmpeg', 'ffprobe', 'font']) if (!existsSync(runtime[key])) throw Object.assign(new Error(`工具运行文件缺失：${key}。请修复 HyperFrames 工具包。`), { code: 'RUNTIME_MISSING' });
  return runtime;
}
export function getManifest() { const p = path.join(componentRoot, 'manifest.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; }
