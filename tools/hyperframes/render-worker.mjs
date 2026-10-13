import { applyRuntimeEnvironment, assertRuntime } from './runtime.mjs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
const send=message=>process.stdout.write(JSON.stringify(message)+'\n');
console.log=(...values)=>process.stderr.write(values.join(' ')+'\n');
const runtime = applyRuntimeEnvironment(); assertRuntime(runtime);
const { createRenderJob, executeRenderJob, resolveConfig } = await import('@hyperframes/producer');
const { parseHTMLContent } = await import('@hyperframes/core/compiler');
const controller = new AbortController();
let started = false;
async function handleMessage(message) {
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
    const document=parseHTMLContent(source);let head=document.querySelector('head');if(!head){head=document.createElement('head');document.documentElement.prepend(head);}
    const csp=document.createElement('meta');csp.setAttribute('http-equiv','Content-Security-Policy');csp.setAttribute('content',"default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; form-action 'none';");head.prepend(csp);
    await fsp.writeFile(inputFile, '<!doctype html>'+document.documentElement.outerHTML);
    const config = resolveConfig({ chromePath: runtime.chrome, concurrency: 1, browserGpuMode: 'software', disableGpu: true, forceScreenshot: true, useDrawElement: false, enableBrowserPool: false, allowSystemFontCapture: false, fps: 30, quality: message.quality });
    const job = createRenderJob({ fps: 30, format: 'mp4', quality: message.quality, workers: 1, useGpu: false, hdrMode: 'force-sdr', logger: silentLogger, producerConfig: config, strictness: 'strict' });
    await executeRenderJob(job, inputDir, message.outputPath, j => { send({ type: 'progress', progress: j.progress, stage: j.currentStage }); }, controller.signal);
    if (controller.signal.aborted || job.status !== 'complete') throw Object.assign(new Error(job.error || `Render ended: ${job.status}`), { code: controller.signal.aborted ? 'CANCELLED' : 'RENDER_FAILED' });
    send({ type: 'complete', outputPath: job.outputPath || message.outputPath, outcome: job.outcome, warnings: job.warnings });
  } catch (error) { send({ type: 'error', code: controller.signal.aborted ? 'CANCELLED' : (error.code || 'RENDER_FAILED'), message: error.message }); }
  finally { await fsp.rm(inputDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});input.close();process.stdout.write('',()=>process.exit(0)); }
}
const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',line=>{try{void handleMessage(JSON.parse(line));}catch{send({type:'error',code:'INVALID_WORKER_REQUEST',message:'Invalid worker request'});}});
input.on('close',()=>controller.abort());
