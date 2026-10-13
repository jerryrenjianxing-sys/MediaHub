import { applyRuntimeEnvironment, assertRuntime } from './runtime.mjs';
import fsp from 'node:fs/promises';
import path from 'node:path';
const runtime = applyRuntimeEnvironment(); assertRuntime(runtime);
const { createRenderJob, executeRenderJob, resolveConfig } = await import('@hyperframes/producer');
const controller = new AbortController();
let started = false;
process.on('message', async message => {
  if (message.type === 'cancel') { controller.abort(); return; }
  if (message.type !== 'render' || started) return;
  started = true;
  const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
  const inputDir = path.join(message.projectDir, '.mediahub', 'render-input', path.basename(message.outputPath, '.mp4'));
  try {
    await fsp.mkdir(inputDir, { recursive: true });
    for (const item of await fsp.readdir(message.projectDir, { withFileTypes: true })) {
      if (item.name.startsWith('.') || item.name === 'renders') continue;
      await fsp.cp(path.join(message.projectDir, item.name), path.join(inputDir, item.name), { recursive: true, dereference: true });
    }
    const inputFile = path.join(inputDir, 'index.html');
    const source = await fsp.readFile(inputFile, 'utf8');
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; form-action 'none';">`;
    await fsp.writeFile(inputFile, source.replace(/<head([^>]*)>/i, `<head$1>${csp}`));
    const config = resolveConfig({ chromePath: runtime.chrome, concurrency: 1, browserGpuMode: 'software', disableGpu: true, forceScreenshot: true, useDrawElement: false, enableBrowserPool: false, allowSystemFontCapture: false, fps: 30, quality: message.quality });
    const job = createRenderJob({ fps: 30, format: 'mp4', quality: message.quality, workers: 1, useGpu: false, hdrMode: 'force-sdr', logger: silentLogger, producerConfig: config, strictness: 'strict' });
    await executeRenderJob(job, inputDir, message.outputPath, j => { process.send?.({ type: 'progress', progress: j.progress, stage: j.currentStage }); }, controller.signal);
    if (controller.signal.aborted || job.status !== 'complete') throw Object.assign(new Error(job.error || `Render ended: ${job.status}`), { code: controller.signal.aborted ? 'CANCELLED' : 'RENDER_FAILED' });
    process.send?.({ type: 'complete', outputPath: job.outputPath || message.outputPath, outcome: job.outcome, warnings: job.warnings });
  } catch (error) { process.send?.({ type: 'error', code: controller.signal.aborted ? 'CANCELLED' : (error.code || 'RENDER_FAILED'), message: error.message }); }
  finally { await fsp.rm(inputDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {}); process.disconnect(); }
});
