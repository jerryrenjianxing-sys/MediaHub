import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { streamSSE } from 'hono/streaming';
import { createStudioApi, getMimeType } from '@hyperframes/studio-server';
import { bundleToSingleHtml, parseHTMLContent } from '@hyperframes/core/compiler';
import { lintProject, lintHyperframeHtml } from '@hyperframes/lint';
import { componentRoot, versions, applyRuntimeEnvironment, assertRuntime } from './runtime.mjs';
import { createTemplate, design } from './template.mjs';
import { studioHtml } from './studio.mjs';

const exec = promisify(execFile);
const error = (code, message) => Object.assign(new Error(message), { code });
const jsonRead = async file => JSON.parse(await fsp.readFile(file, 'utf8'));
const writeJson = async (file, value) => { await fsp.mkdir(path.dirname(file), {recursive:true}); const temp = `${file}.${crypto.randomUUID()}.tmp`; await fsp.writeFile(temp, JSON.stringify(value, null, 2)); await fsp.rename(temp, file); };
const hashFile = async file => {const digest=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))digest.update(chunk);return digest.digest('hex');};
function serialTask(task) { const {worker,done,resolveDone,timer,...value} = task; return value; }
function inside(root, target) { const rel = path.relative(root, target); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`); }
async function safeFile(root, relative) { const full = path.resolve(root, relative); if (!inside(root, full)) throw error('INVALID_PATH','File must be inside the project'); const canonical = await fsp.realpath(full); if (!inside(await fsp.realpath(root), canonical)) throw error('INVALID_PATH','Links outside the project are not allowed'); return canonical; }
async function listen(app) { return new Promise((resolve,reject) => { const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0}, info=>resolve({server,port:info.port})); server.on('error',reject); }); }
async function closeServer(server) { if (!server) return; server.closeAllConnections?.(); await new Promise(resolve=>server.close(resolve)); }

export class HyperframesAdapter {
  constructor({onEvent=()=>{}, runtime,cancelTimeoutMs=15000}={}) {
    this.runtime=runtime || applyRuntimeEnvironment(); this.onEvent=onEvent;
    this.projects=new Map(); this.tasks=new Map(); this.activeTask=null; this.closed=false;
    this.cancelTimeoutMs=cancelTimeoutMs;
    this.watchers=new Map(); this.clients=new Set(); this.browsers=new Set(); this.browserLaunches=new Set(); this.pendingStudio=new Map(); this.instanceToken=crypto.randomBytes(32).toString('hex'); this.connected=false;
  }
  emit(value) { this.onEvent(value); for (const notify of this.clients) notify(value); }
  async dispatch(method, params={}) {
    if (method==='stop') method='shutdown';
    if (!['create','preview','lint','check','render','cancel','status','shutdown','import'].includes(method)) throw error('UNKNOWN_METHOD',`Unsupported operation: ${method}`);
    if (this.closed && method!=='shutdown') throw error('TOOL_CLOSED','Tool is shutting down');
    return this[method](params);
  }
  async project(projectDir) {
    if (typeof projectDir!=='string' || !path.isAbsolute(projectDir)) throw error('INVALID_PROJECT','An absolute projectDir is required');
    const dir=await fsp.realpath(projectDir); const file=await safeFile(dir,'mediahub-hyperframes.json');
    const metadata=await jsonRead(file);
    if(fs.existsSync(path.join(dir,'index.html')))try{const document=parseHTMLContent(await fsp.readFile(await safeFile(dir,'index.html'),'utf8'));const root=document.querySelector('[data-composition-id]');const duration=Number(root?.getAttribute('data-duration') || document.documentElement.getAttribute('data-composition-duration'));if(Number.isFinite(duration)&&duration>0)metadata.duration=duration;}catch{}
    if (metadata.tool!=='hyperframes' || !/^[a-zA-Z0-9_-]{1,100}$/.test(metadata.id)) throw error('INVALID_PROJECT','This is not a MediaHub HyperFrames project');
    const platformFile=path.join(dir,'project.json'); const platformMetadata=fs.existsSync(platformFile)?await jsonRead(await safeFile(dir,'project.json')):null;
    const platformId=platformMetadata?.id || metadata.platformProjectId || metadata.id;
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(platformId))throw error('INVALID_PROJECT','Invalid platform project identity');
    const project={id:platformId,upstreamProjectId:metadata.id,dir,title:platformMetadata?.name || metadata.title,metadata};if(platformId!==metadata.id)this.projects.delete(metadata.id); this.projects.set(project.id,project);
    const recordDir=path.join(dir,'.mediahub','tasks');
    if (fs.existsSync(recordDir)) for (const name of await fsp.readdir(recordDir)) {
      if (!name.endsWith('.json')) continue;
      const saved=await jsonRead(path.join(recordDir,name)).catch(()=>null);
      if (!saved || this.tasks.has(saved.id)) continue;
      saved.projectId=project.id;
      if (['rendering','queued','validating'].includes(saved.status)) { saved.status='interrupted'; saved.error='上次执行异常结束；请检查输出文件后重新发起任务。'; saved.endedAt=new Date().toISOString(); await writeJson(path.join(recordDir,name),saved); }
      this.tasks.set(saved.id,saved);
    }
    return project;
  }
  async create({projectDir,projectId,title='我的视频项目',orientation='landscape',duration=6,assets=[]}) {
    assertRuntime(this.runtime);
    if (!['landscape','portrait'].includes(orientation)) throw error('INVALID_ORIENTATION','Use landscape or portrait');
    if (!Number.isFinite(duration) || duration<1 || duration>600) throw error('INVALID_DURATION','Duration must be between 1 and 600 seconds');
    if (!path.isAbsolute(projectDir || '')) throw error('INVALID_PROJECT','An absolute projectDir is required');
    const dir=path.resolve(projectDir);
    const platformMetadata=fs.existsSync(path.join(dir,'project.json'))?await jsonRead(path.join(dir,'project.json')):null;
    const id=projectId || platformMetadata?.id || crypto.randomUUID();
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || (platformMetadata?.id && platformMetadata.id!==id))throw error('INVALID_PROJECT','HyperFrames must use the platform project identity');
    // A platform project may already contain metadata; never overwrite a composition.
    if (fs.existsSync(path.join(dir,'index.html')) || fs.existsSync(path.join(dir,'mediahub-hyperframes.json'))) throw error('PROJECT_EXISTS','This project already contains a composition');
    await fsp.mkdir(path.join(dir,'assets'),{recursive:true}); await fsp.mkdir(path.join(dir,'renders'),{recursive:true});
    const metadata={schemaVersion:1,id,platformProjectId:id,tool:'hyperframes',toolVersion:versions.tool,title:String(title).slice(0,200),orientation,width:orientation==='portrait'?1080:1920,height:orientation==='portrait'?1920:1080,fps:30,duration,createdAt:new Date().toISOString(),assets:[]};
    await fsp.copyFile(this.runtime.font,path.join(dir,'assets','NotoSansSC.ttf'));
    for (const filename of ['gsap.min.js','CustomEase.min.js','MotionPathPlugin.min.js']) await fsp.copyFile(path.join(componentRoot,'node_modules','gsap','dist',filename),path.join(dir,'assets',filename));
    await fsp.writeFile(path.join(dir,'index.html'),createTemplate(metadata)); await fsp.writeFile(path.join(dir,'DESIGN.md'),design);
    await writeJson(path.join(dir,'hyperframes.json'),{name:metadata.title,version:1});
    await writeJson(path.join(dir,'mediahub-hyperframes.json'),metadata);
    if (assets.length) await this.import({projectDir:dir,assets});
    return {projectDir:dir,projectId:id,entry:path.join(dir,'index.html'),width:metadata.width,height:metadata.height,fps:30,orientation};
  }
  async import({projectDir,assets=[]}) {
    const project=await this.project(projectDir);
    if (!Array.isArray(assets) || assets.length>100) throw error('INVALID_ASSETS','At most 100 assets per request');
    for (const asset of assets) {
      if (!/^[a-zA-Z0-9_.-]{1,120}$/.test(asset.assetId || '') || !path.isAbsolute(asset.sourcePath || '')) throw error('INVALID_ASSET','Each asset needs an assetId and absolute sourcePath');
      const sourcePath=await fsp.realpath(asset.sourcePath); if (!(await fsp.stat(sourcePath)).isFile()) throw error('INVALID_ASSET','Asset must be a file');
      const sha256=await hashFile(sourcePath);
      const filename=`${asset.assetId}-${sha256.slice(0,12)}${path.extname(sourcePath).toLowerCase()}`;
      const relativePath=`assets/${filename}`; await fsp.copyFile(sourcePath,path.join(project.dir,relativePath));
      const mapping={assetId:asset.assetId,sourcePath,relativePath,sha256,importedAt:new Date().toISOString()};
      project.metadata.assets=project.metadata.assets.filter(a=>a.assetId!==asset.assetId); project.metadata.assets.push(mapping);
    }
    await writeJson(path.join(project.dir,'mediahub-hyperframes.json'),project.metadata);
    return {projectId:project.id,assets:project.metadata.assets};
  }
  async lint({projectDir}) {
    const project=await this.project(projectDir); const result=await lintProject(project.dir);
    // This tool's offline contract includes all authored HTML/CSS dependencies.
    const offlineFindings=[];
    const visit=async dir=>{ for (const item of await fsp.readdir(dir,{withFileTypes:true})) {
      if (item.name.startsWith('.') || item.name==='renders') continue;
      const file=path.join(dir,item.name); if (item.isSymbolicLink()) { await safeFile(project.dir,path.relative(project.dir,file)); continue; }
      if (item.isDirectory()) await visit(file);
      else if (/\.(html|css)$/i.test(item.name)) { const text=await fsp.readFile(file,'utf8'); if (/(?:\b(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\/|\burl\(\s*["']?(?:https?:)?\/\/|@import\s+["'](?:https?:)?\/\/)/i.test(text)) offlineFindings.push({code:'mediahub_remote_resource',severity:'error',file:path.relative(project.dir,file),message:'离线工具包不允许远端脚本、字体或媒体，请先导入到 assets。'}); }
    }}; await visit(project.dir);
    const findings=[...result.results.flatMap(item=>item.result.findings.map(f=>({...f,file:f.file || item.file}))),...offlineFindings];
    return {...result,findings,ok:result.totalErrors===0 && offlineFindings.length===0,totalErrors:result.totalErrors+offlineFindings.length};
  }
  async check({projectDir}) {
    if(this.closed)throw error('TOOL_CLOSED','Tool is shutting down');
    assertRuntime(this.runtime); const project=await this.project(projectDir); const lint=await this.lint({projectDir:project.dir});
    if (!lint.ok) return {ok:false,lint,browser:{ok:false,skipped:true,reason:'先修复静态检查错误'}};
    await this.ensureServers(); const {default:puppeteer}=await import('puppeteer-core');
    const launching=puppeteer.launch({executablePath:this.runtime.chrome,headless:true,timeout:20000,args:['--disable-gpu','--disable-extensions','--no-first-run','--disable-background-networking']});this.browserLaunches.add(launching);
    let browser;try{browser=await launching;}finally{this.browserLaunches.delete(launching);}
    this.browsers.add(browser);
    try {
      if(this.closed)throw error('TOOL_CLOSED','Tool is shutting down');
      const page=await browser.newPage(); await page.setViewport({width:project.metadata.width,height:project.metadata.height});
      const errors=[]; const blocked=[]; page.on('pageerror',e=>errors.push(e.message));
      await page.setRequestInterception(true); page.on('request',request=>{ const url=request.url(); if (/^(data:|blob:)/.test(url) || url.startsWith(this.previewOrigin+'/')) request.continue(); else {blocked.push(url); request.abort();} });
      await page.goto(`${this.previewOrigin}/p/${project.id}/preview`,{waitUntil:'networkidle0',timeout:45000});
      await page.evaluate(()=>document.fonts.ready); await page.waitForFunction(()=>window.__playerReady===true,{timeout:15000});
      const actualDuration=await page.evaluate(()=>window.__player.getDuration());
      const sampled=[];
      for (const time of [0,Math.min(.5,actualDuration/2),actualDuration/2,Math.max(0,actualDuration-.1)]) {
        await page.evaluate(async t=>{ const h=window.__player; if (!h?.seek) throw Error('Runtime player was not initialized'); await h.seek(t); await new Promise(requestAnimationFrame); },time);
        const sample=await page.evaluate(()=>{ const root=document.querySelector('[data-composition-id]'); const box=root?.getBoundingClientRect(); return {width:box?.width,height:box?.height,timelineCount:Object.keys(window.__timelines||{}).length,actualTime:window.__player?.getTime(),visibleText:[...document.querySelectorAll('h1,h2,p')].filter(el=>Number(getComputedStyle(el).opacity)>.5).length}; }); sampled.push({time,...sample});
      }
      const dimensionsOk=sampled.every(s=>s.width===project.metadata.width && s.height===project.metadata.height);
      const seekOk=sampled.every(s=>Number.isFinite(s.actualTime)&&Math.abs(s.actualTime-s.time)<.05);
      const diagnosticsDir=path.join(project.dir,'.mediahub','checks'); await fsp.mkdir(diagnosticsDir,{recursive:true});
      const screenshot=path.join(diagnosticsDir,`check-${Date.now()}.png`); await page.screenshot({path:screenshot});
      const browserResult={ok:errors.length===0 && blocked.length===0 && dimensionsOk && seekOk,errors,blockedRequests:blocked,sampled,dimensionsOk,seekOk,duration:actualDuration,screenshot};
      return {ok:lint.ok && browserResult.ok,lint,browser:browserResult};
    } finally { await browser.close(); this.browsers.delete(browser); }
  }
  async startTask({projectDir,taskId=crypto.randomUUID(),quality='standard',outputPath,source='agent',composition,variables}) {
    if(this.closed)throw error('TOOL_CLOSED','Tool is shutting down');
    assertRuntime(this.runtime); if (this.activeTask || this.renderStarting) throw error('RENDER_BUSY','已有视频正在导出，请等待或取消后重试。');
    this.renderStarting=true;
    try {
    if (!/^[a-zA-Z0-9_.-]{1,160}$/.test(taskId)) throw error('INVALID_TASK_ID','Invalid taskId');
    if (this.tasks.has(taskId)) throw error('TASK_EXISTS','Task IDs cannot be reused');
    if (!['draft','standard','high'].includes(quality)) throw error('INVALID_QUALITY','Invalid render quality');
    const project=await this.project(projectDir);
    if(this.closed)throw error('TOOL_CLOSED','Tool is shutting down');
    const target=outputPath || path.join(project.dir,'renders',`${taskId}.mp4`);
    if (!inside(path.join(project.dir,'renders'),path.resolve(target)) || path.extname(target)!=='.mp4') throw error('INVALID_OUTPUT','Output must be an MP4 inside project/renders');
    if (fs.existsSync(target)) throw error('OUTPUT_EXISTS','Existing output is never overwritten');
    const task={id:taskId,taskId,projectId:project.id,projectDir:project.dir,source,status:'queued',progress:0,stage:'检查工程',outputPath:target,startedAt:new Date().toISOString(),recordPath:path.join(project.dir,'.mediahub','tasks',`${taskId}.json`)};
    task.done=new Promise(resolve=>task.resolveDone=resolve); this.tasks.set(taskId,task); this.activeTask=taskId;
    try{await writeJson(task.recordPath,serialTask(task));}
    catch(e){task.status='failed';task.error=e.message;task.errorCode=e.code || 'TASK_RECORD_FAILED';task.stage='任务记录失败';task.endedAt=new Date().toISOString();if(task.timer)clearTimeout(task.timer);this.activeTask=null;this.emit({event:'task',...serialTask(task)});task.resolveDone(serialTask(task));throw e;}
    this.emit({event:'task',...serialTask(task)});
    void this.execute(task,quality,composition,variables);
    return task;
    } finally { this.renderStarting=false; }
  }
  async render(params) { const task=await this.startTask({...params,source:'agent'}); return {accepted:true,taskId:task.id,status:task.status,outputPath:task.outputPath}; }
  async execute(task,quality,composition,variables) {
    try {
      const lint=await this.lint({projectDir:task.projectDir}); if (!lint.ok) throw error('LINT_FAILED',`静态检查发现 ${lint.totalErrors} 个错误。`);
      if (task.cancelRequested) throw error('CANCELLED','Cancelled before render started');
      if (composition || variables) throw error('UNSUPPORTED_RENDER_OPTION','First release renders the project index without variable overrides');
      task.status='rendering'; task.stage='准备导出'; await writeJson(task.recordPath,serialTask(task));
      const child=spawn(this.runtime.native,['job','--',this.runtime.node,path.join(componentRoot,'render-worker.mjs')],{cwd:task.projectDir,env:{...process.env},stdio:['pipe','pipe','pipe'],windowsHide:true}); task.worker=child;
      let result=null; let stderr=''; child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});
      readline.createInterface({input:child.stdout}).on('line',line=>{let message;try{message=JSON.parse(line);}catch{return;}if (message.type==='progress') { task.progress=Math.max(task.progress,Math.min(99,Number(message.progress)||0)); task.stage=message.stage; this.emit({event:'progress',taskId:task.id,progress:task.progress,stage:task.stage}); } else result=message; });
      child.stdin.on('error',()=>{});
      await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{ if (task.cancelRequested || result?.code==='CANCELLED') reject(error('CANCELLED','视频导出已取消')); else if (code!==0 || result?.type!=='complete') reject(error(result?.code || 'RENDER_FAILED',result?.message || `Render process group stopped (${code ?? signal}): ${stderr}`)); else resolve(); }); child.stdin.write(JSON.stringify({type:'render',projectDir:task.projectDir,outputPath:task.outputPath,quality})+'\n');});
      task.worker=null; task.status='validating'; task.stage='校验成片';
      const {stdout}=await exec(this.runtime.ffprobe,['-v','error','-show_format','-show_streams','-of','json',task.outputPath],{windowsHide:true,timeout:30000,maxBuffer:1024*1024});
      const media=JSON.parse(stdout); const video=media.streams?.find(s=>s.codec_type==='video'); const project=await this.project(task.projectDir);
      if (!video || video.codec_name!=='h264' || video.width!==project.metadata.width || video.height!==project.metadata.height || video.avg_frame_rate!=='30/1' || Number(media.format?.duration)<=0) throw error('INVALID_MEDIA','输出未通过视频格式、尺寸、帧率和时长校验');
      if (task.cancelRequested) throw error('CANCELLED','视频导出已取消');
      task.status='complete'; task.progress=100; task.stage='完成'; task.media=media; task.mediaValidated=true;
      task.artifact={path:task.outputPath,name:path.basename(task.outputPath),mediaValidated:true,media};
    } catch(e) { task.status=e.code==='CANCELLED'?'cancelled':'failed'; task.error=e.message; task.errorCode=e.code || 'RENDER_FAILED'; task.stage=task.status==='cancelled'?'已取消':'失败'; }
    finally { task.worker=null; if(task.timer)clearTimeout(task.timer); task.endedAt=new Date().toISOString(); await writeJson(task.recordPath,serialTask(task)).catch(()=>{}); this.activeTask=null; this.emit({event:'task',...serialTask(task)}); task.resolveDone?.(serialTask(task)); }
  }
  async cancel({taskId}) {
    const task=this.tasks.get(taskId); if(!task)throw error('TASK_NOT_FOUND','Task not found');
    if(!['queued','rendering','validating'].includes(task.status)){if(this.activeTask===taskId&&task.done)await task.done;return {taskId,status:task.status,stopped:true};}
    if(task.cancelRequested){await task.done;return {taskId,status:task.status,stopped:true};}
    task.cancelRequested=true;task.worker?.stdin.write(JSON.stringify({type:'cancel'})+'\n');
    // Killing this wrapper closes only this render's native Job Object, including detached descendants.
    task.timer=setTimeout(()=>{task.worker?.kill('SIGKILL');},this.cancelTimeoutMs);
    await task.done; return {taskId,status:task.status,stopped:true};
  }
  async status({taskId,projectDir}={}) {
    if(projectDir)await this.project(projectDir);
    const runtime={...this.runtime}; const healthy=['node','chrome','ffmpeg','ffprobe','font','native'].every(k=>runtime[k]&&fs.existsSync(runtime[k]));
    if(taskId){const task=this.tasks.get(taskId);if(!task)throw error('TASK_NOT_FOUND','Task not found');return serialTask(task);}
    const tasks=[...this.tasks.values()].slice(-100).map(t=>({taskId:t.taskId,id:t.id,source:t.source,projectId:t.projectId,status:t.status,progress:t.progress,stage:t.stage,outputPath:t.outputPath,error:t.error,startedAt:t.startedAt,endedAt:t.endedAt}));
    return {healthy,versions,runtime,activeRender:this.activeTask,taskCount:this.tasks.size,tasks,pid:process.pid};
  }
  async preview({projectDir}) {
    const project=await this.project(projectDir); assertRuntime(this.runtime);await this.ensureServers();
    if(!this.watchers.has(project.id)) { let timer; const watcher=fs.watch(project.dir,{recursive:true},(_event,filename)=>{ if(!filename || /(?:^|[\\/])(?:\.mediahub|renders)(?:[\\/]|$)/.test(filename))return;clearTimeout(timer);timer=setTimeout(()=>this.emit({event:'project-changed',projectId:project.id}),150);}); const close=watcher.close.bind(watcher);watcher.close=()=>{clearTimeout(timer);close();};this.watchers.set(project.id,watcher); }
    return {studioUrl:`${this.studioOrigin}/connect?token=${this.instanceToken}&project=${project.id}`,previewUrl:`${this.previewOrigin}/p/${project.id}/preview`,ownPid:process.pid,tokenScope:'hyperframes-studio-instance',projectId:project.id};
  }
  async ensureServers() {
    if(this.serverPromise)return this.serverPromise;
    this.serverPromise=this.startServers();return this.serverPromise;
  }
  async startServers() {
    const preview=new Hono();
    preview.use('*',async(c,next)=>{ if(c.req.header('host')!==`127.0.0.1:${this.previewPort}`)return c.text('Invalid host',403);c.header('Content-Security-Policy',`default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors ${this.studioOrigin}`);c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','no-referrer');await next();});
    preview.get('/p/:id/preview',async c=>{const project=this.projects.get(c.req.param('id'));if(!project)return c.text('Not found',404);let html=await bundleToSingleHtml(project.dir,{inlineAssets:false,runtime:'inline',stampHfIds:false});
      html=html.replace(/<head([^>]*)>/i,`<head$1><base href="/p/${project.id}/files/">`);
      // The preview knows only the parent's origin, never its instance token or cookie.
      const bridge=`<script>addEventListener('message',e=>{if(e.source!==parent||e.origin!==${JSON.stringify(this.studioOrigin)}||e.data?.source!=='mediahub-studio')return;const h=window.__player;if(e.data.action==='seek')h?.seek(e.data.time);if(e.data.action==='play')h?.play();if(e.data.action==='pause')h?.pause();});const readyTimer=setInterval(()=>{if(window.__playerReady&&window.__player){clearInterval(readyTimer);parent.postMessage({source:'mediahub-preview',type:'ready'},${JSON.stringify(this.studioOrigin)});}},25);setTimeout(()=>clearInterval(readyTimer),30000);</script>`;
      return c.html(html.replace('</body>',bridge+'</body>'));});
    preview.get('/p/:id/files/*',async c=>{
      const project=this.projects.get(c.req.param('id'));if(!project)return c.text('Not found',404);
      const relative=decodeURIComponent(new URL(c.req.url).pathname.split('/files/')[1]||'');if(relative.split(/[\\/]/).some(segment=>segment.startsWith('.')) || /(?:mediahub-hyperframes|project)\.json$/i.test(relative))return c.text('Not found',404);
      try{const file=await safeFile(project.dir,relative);const stat=await fsp.stat(file);if(!stat.isFile())return c.text('Not found',404);const range=c.req.header('range');let start=0,end=stat.size-1,status=200;
        if(range){const match=range.match(/^bytes=(\d*)-(\d*)$/);if(!match || (!match[1]&&!match[2]))return c.body(null,416,{'Content-Range':`bytes */${stat.size}`});
          if(!match[1])start=Math.max(0,stat.size-Number(match[2]));else start=Number(match[1]);if(match[1]&&match[2])end=Math.min(end,Number(match[2]));
          if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=stat.size)return c.body(null,416,{'Content-Range':`bytes */${stat.size}`});status=206;
        }
        const headers={'Content-Type':getMimeType(file),'Accept-Ranges':'bytes','Content-Length':String(Math.max(0,end-start+1))};if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
        if(stat.size===0)return c.body(null,200,headers);return c.body(Readable.toWeb(fs.createReadStream(file,{start,end})),status,headers);
      }catch{return c.text('Not found',404);}
    });
    const p=await listen(preview);this.previewServer=p.server;this.previewPort=p.port;this.previewOrigin=`http://127.0.0.1:${p.port}`;
    const studio=new Hono();
    studio.use('*',async(c,next)=>{ if(c.req.header('host')!==`localhost:${this.studioPort}`)return c.text('Invalid host',403);c.header('Referrer-Policy','no-referrer');c.header('X-Content-Type-Options','nosniff');c.header('Content-Security-Policy',`default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src ${this.previewOrigin}; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
      if(c.req.path==='/connect'){if(c.req.query('token')!==this.instanceToken)return c.text('Invalid tool connection',403);c.header('Set-Cookie',`mh_hf=${this.instanceToken}; HttpOnly; SameSite=Strict; Path=/`);return c.redirect(`/#project/${encodeURIComponent(c.req.query('project')||'')}`);}
      const cookie=c.req.header('cookie')||'';if(!cookie.split(';').some(v=>v.trim()===`mh_hf=${this.instanceToken}`))return c.text('Connect through MediaHub',401);
      if(!['GET','HEAD'].includes(c.req.method)&&c.req.header('origin')!==this.studioOrigin)return c.text('Invalid origin',403);
      await next();});
    studio.get('/',c=>c.html(studioHtml(this.previewOrigin)));
    studio.get('/mediahub/projects',async c=>{const projects=await Promise.all([...this.projects.values()].map(p=>this.project(p.dir)));return c.json(projects.map(p=>({...p.metadata,id:p.id,title:p.title,previewUrl:`${this.previewOrigin}/p/${p.id}/preview`})))});
    studio.get('/mediahub/projects/:id/source',async c=>{const p=this.projects.get(c.req.param('id'));if(!p)return c.text('Not found',404);return c.text(await fsp.readFile(await safeFile(p.dir,'index.html'),'utf8'));});
    studio.put('/mediahub/projects/:id/source',async c=>{const p=this.projects.get(c.req.param('id'));if(!p)return c.text('Not found',404);if(this.activeTask)return c.json({error:'导出时不能修改工程'},409);const source=await c.req.text();if(Buffer.byteLength(source)>2*1024*1024)return c.json({error:'Source exceeds 2 MiB'},413);await fsp.writeFile(await safeFile(p.dir,'index.html'),source);this.emit({event:'project-changed',projectId:p.id});return c.json({saved:true});});
    studio.post('/mediahub/projects/:id/check',async c=>{const p=this.projects.get(c.req.param('id'));if(!p)return c.text('Not found',404);return c.json(await this.check({projectDir:p.dir}));});
    studio.get('/mediahub/projects/:id/lint',async c=>{const p=this.projects.get(c.req.param('id'));if(!p)return c.text('Not found',404);return c.json(await this.lint({projectDir:p.dir}));});
    studio.post('/mediahub/tasks/:id/cancel',async c=>c.json(await this.cancel({taskId:c.req.param('id')})));
    studio.post('/api/render/:jobId/cancel',async c=>{const taskId=c.req.param('jobId');try{const pending=this.pendingStudio.get(taskId);if(pending)await pending;return c.json(await this.cancel({taskId}));}catch(e){return c.json({error:e.message,code:e.code || 'CANCEL_FAILED',stopped:false},e.code==='TASK_NOT_FOUND'?404:409);}});
    studio.get('/mediahub/events',c=>streamSSE(c,async stream=>{const notify=value=>stream.writeSSE({data:JSON.stringify(value)}).catch(()=>{});this.clients.add(notify);await new Promise(resolve=>stream.onAbort(resolve));this.clients.delete(notify);}));
    const studioAdapter={listProjects:()=>[...this.projects.values()],resolveProject:id=>this.projects.get(id)||null,bundle:(dir,options)=>bundleToSingleHtml(dir,{...options,inlineAssets:true}),lint:(html,opts)=>lintHyperframeHtml(html,opts),lintProject:dir=>lintProject(dir),runtimeUrl:`${this.previewOrigin}/runtime.js`,rendersDir:project=>path.join(project.dir,'renders'),startRender:opts=>{
      const state={id:opts.jobId,status:'rendering',progress:0,stage:'准备',outputPath:opts.outputPath};
      if(opts.format!=='mp4'||opts.fps.num!==30||opts.fps.den!==1){state.status='failed';state.error='首版仅支持 MP4 / 30fps / SDR';return state;}
      const pending=this.startTask({projectDir:opts.project.dir,taskId:opts.jobId,quality:opts.quality,outputPath:opts.outputPath,source:'studio',composition:opts.composition,variables:opts.variables});this.pendingStudio.set(opts.jobId,pending);pending.then(task=>{
        state.cancel=()=>{void this.cancel({taskId:task.id});};const timer=setInterval(()=>{state.progress=task.progress;state.stage=task.stage;},200);task.done.then(result=>{clearInterval(timer);state.status=result.status==='complete'?'complete':result.status==='cancelled'?'cancelled':'failed';state.progress=result.progress;state.error=result.error;});
      }).catch(e=>{state.status='failed';state.error=e.message;}).finally(()=>this.pendingStudio.delete(opts.jobId));return state;
    }};
    studio.post('/api/projects/:id/render',async c=>{
      const project=this.projects.get(c.req.param('id'));if(!project)return c.json({error:'Project not found'},404);
      const body=await c.req.json().catch(()=>({}));if((body.format&&body.format!=='mp4')||(body.fps!==undefined&&Number(body.fps)!==30))return c.json({error:'首版仅支持 MP4 / 30fps / SDR'},400);
      const jobId=`studio_${crypto.randomUUID()}`;const state=studioAdapter.startRender({project,outputPath:path.join(project.dir,'renders',`${jobId}.mp4`),jobId,format:'mp4',fps:{num:30,den:1},quality:body.quality || 'standard',composition:body.composition,variables:body.variables,telemetryOptOut:true});
      try{const pending=this.pendingStudio.get(jobId);if(pending)await pending;else if(state.status==='failed')throw error('INVALID_RENDER',state.error);return c.json({jobId,status:'rendering'});}
      catch(e){return c.json({error:e.message,code:e.code || 'RENDER_FAILED'},e.code==='RENDER_BUSY'?409:400);}
    });
    studio.get('/api/render/:jobId/progress',c=>{const task=this.tasks.get(c.req.param('jobId'));if(!task)return c.json({error:'Task not found'},404);return streamSSE(c,async stream=>{
      while(!stream.aborted){await stream.writeSSE({event:'progress',data:JSON.stringify({progress:task.progress,status:task.status,stage:task.stage,error:task.error})});if(!['queued','rendering','validating'].includes(task.status))break;await new Promise(resolve=>setTimeout(resolve,250));}
    });});
    // Deliberately expose only supported routes. Global assets/registry/install APIs are unavailable.
    studio.use('/api/*',async(c,next)=>{const allowed=/^\/api\/(?:projects(?:\/[^/]+(?:\/lint|\/render))?|render\/[^/]+\/progress)$/.test(c.req.path);if(!allowed)return c.json({error:'Unsupported studio route'},404);await next();});
    studio.route('/api',createStudioApi(studioAdapter));
    const s=await listen(studio);this.studioServer=s.server;this.studioPort=s.port;this.studioOrigin=`http://localhost:${s.port}`;
  }
  async shutdown({idleOnly=false}={}) {
    // This check and the closed flag are synchronous: a competing startTask
    // either owns the render reservation or observes the closed flag.
    if(idleOnly && (this.activeTask || this.renderStarting))throw error('TOOL_BUSY','已有视频正在导出或等待导出，暂时不能更新、卸载或停止工具。');
    if(this.shutdownPromise)return this.shutdownPromise;
    this.closed=true;this.shutdownPromise=(async()=>{if(this.activeTask)await this.cancel({taskId:this.activeTask});await Promise.allSettled([...this.browserLaunches]);await Promise.allSettled([...this.browsers].map(browser=>browser.close()));this.browsers.clear();for(const watcher of this.watchers.values())watcher.close();this.watchers.clear();await Promise.all([closeServer(this.studioServer),closeServer(this.previewServer)]);return {stopped:true};})();return this.shutdownPromise;
  }
}
