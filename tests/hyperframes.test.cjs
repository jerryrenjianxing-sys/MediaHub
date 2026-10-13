const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {existsSync}=require('node:fs');
const repo=path.resolve(__dirname,'..');
const runtimePresent=existsSync(path.join(repo,'tools','hyperframes','stage','runtime','node','node.exe'));
const modulePromise=import(pathToFileURL(path.join(repo,'tools','hyperframes','adapter.mjs')));
async function fixture(t){const{HyperframesAdapter}=await modulePromise;await fs.mkdir(path.join(repo,'work'),{recursive:true});const root=await fs.mkdtemp(path.join(repo,'work','HF 测试 '));const events=[];const adapter=new HyperframesAdapter({onEvent:e=>events.push(e)});t.after(()=>adapter.shutdown());return {root,adapter,events};}
const waitFor=async(predicate,timeout=90000)=>{const started=Date.now();while(!await predicate()){if(Date.now()-started>timeout)throw Error('Timed out');await new Promise(r=>setTimeout(r,100));}};

test('unknown method and missing runtime fail clearly',async t=>{const{HyperframesAdapter}=await modulePromise;const adapter=new HyperframesAdapter({runtime:{node:'missing',chrome:'missing',ffmpeg:'missing',ffprobe:'missing',font:'missing'}});t.after(()=>adapter.shutdown());await assert.rejects(adapter.dispatch('shell',{command:'anything'}),{code:'UNKNOWN_METHOD'});assert.equal((await adapter.status()).healthy,false);await assert.rejects(adapter.create({projectDir:path.join(repo,'work','uncreated')}),{code:'RUNTIME_MISSING'});});

test('offline local create, asset identity, source refresh and origin isolation',{skip:!runtimePresent},async t=>{const{root,adapter}=await fixture(t);const projectDir=path.join(root,'横屏 项目');const project=await adapter.create({projectDir,title:'中文本地测试',duration:1});assert.equal(project.width,1920);assert.equal(project.fps,30);const source=await fs.readFile(project.entry,'utf8');assert.ok(!/(?:src|href)=["']https?:/i.test(source));await assert.rejects(adapter.create({projectDir}),{code:'PROJECT_EXISTS'});const asset=path.join(root,'品牌 标记.txt');await fs.writeFile(asset,'brand');const imported=await adapter.import({projectDir,assets:[{assetId:'asset-brand',sourcePath:asset}]});assert.equal(imported.assets[0].assetId,'asset-brand');assert.equal(await fs.readFile(path.join(projectDir,imported.assets[0].relativePath),'utf8'),'brand');assert.equal((await adapter.lint({projectDir})).ok,true);const urls=await adapter.preview({projectDir});assert.notEqual(new URL(urls.studioUrl).origin,new URL(urls.previewUrl).origin);const connect=await fetch(urls.studioUrl,{redirect:'manual'});assert.equal(connect.status,302);const cookie=connect.headers.get('set-cookie').split(';')[0];assert.match(connect.headers.get('set-cookie'),/HttpOnly/);const origin=new URL(urls.studioUrl).origin;assert.equal((await fetch(origin+'/mediahub/projects')).status,401);const projects=await fetch(origin+'/mediahub/projects',{headers:{cookie}});assert.equal(projects.status,200);const denied=await fetch(origin+'/mediahub/projects/'+project.projectId+'/source',{method:'PUT',headers:{cookie,origin:new URL(urls.previewUrl).origin},body:'attacker'});assert.equal(denied.status,403);assert.equal((await fetch(origin+'/api/global-assets',{headers:{cookie}})).status,404);const preview=await fetch(urls.previewUrl);const html=await preview.text();assert.ok(!html.includes(new URL(urls.studioUrl).searchParams.get('token')));assert.match(preview.headers.get('content-security-policy'),/connect-src 'self'/);const rangedUrl=new URL('/p/'+project.projectId+'/files/'+imported.assets[0].relativePath,urls.previewUrl);const ranged=await fetch(rangedUrl,{headers:{range:'bytes=1-3'}});assert.equal(ranged.status,206);assert.equal(await ranged.text(),'ran');assert.equal(ranged.headers.get('content-range'),'bytes 1-3/5');assert.equal((await fetch(rangedUrl,{headers:{range:'bytes=99-100'}})).status,416);const check=await adapter.check({projectDir});assert.equal(check.ok,true,JSON.stringify(check));assert.equal(check.browser.blockedRequests.length,0);});

test('remote resources rejected, bad input and interrupted tasks preserved',{skip:!runtimePresent},async t=>{const{root,adapter}=await fixture(t);const projectDir=path.join(root,'竖屏');const project=await adapter.create({projectDir,orientation:'portrait',duration:1});assert.equal(project.height,1920);assert.equal(project.width,1080);await fs.appendFile(project.entry,'<script src="https://example.invalid/remote.js"></script>');const lint=await adapter.lint({projectDir});assert.equal(lint.ok,false);assert.ok(lint.findings.some(f=>f.code==='mediahub_remote_resource'));await assert.rejects(adapter.import({projectDir,assets:[{assetId:'../escape',sourcePath:project.entry}]}),{code:'INVALID_ASSET'});const record=path.join(projectDir,'.mediahub','tasks','interrupted.json');await fs.mkdir(path.dirname(record),{recursive:true});await fs.writeFile(record,JSON.stringify({id:'interrupted',taskId:'interrupted',status:'rendering',projectDir,outputPath:path.join(projectDir,'renders','unknown.mp4')}));const status=await adapter.status({projectDir,taskId:'interrupted'});assert.equal(status.status,'interrupted');assert.ok(!status.artifact);});

test('real Producer render and ffprobe success, one-render limit, actual cancellation',{skip:!runtimePresent,timeout:150000},async t=>{const{root,adapter,events}=await fixture(t);const projectDir=path.join(root,'成片');await adapter.create({projectDir,title:'本地成片',duration:1});const accepted=await adapter.render({projectDir,taskId:'real-render',quality:'draft'});assert.equal(accepted.accepted,true);await assert.rejects(adapter.render({projectDir,taskId:'concurrent'}),{code:'RENDER_BUSY'});await waitFor(()=>!adapter.activeTask);const completed=await adapter.status({taskId:'real-render'});assert.equal(completed.status,'complete',completed.error);assert.equal(completed.mediaValidated,true);assert.equal(completed.media.streams[0].width,1920);assert.equal(completed.media.streams[0].avg_frame_rate,'30/1');assert.ok((await fs.stat(completed.outputPath)).size>1000);assert.ok(events.some(e=>e.event==='progress'&&e.taskId==='real-render'));const sourceFile=path.join(projectDir,'index.html');let source=await fs.readFile(sourceFile,'utf8');source=source.replace('data-duration="1"','data-duration="40"');await fs.writeFile(sourceFile,source);await adapter.render({projectDir,taskId:'real-cancel',quality:'draft'});await waitFor(()=>adapter.tasks.get('real-cancel').progress>=27);const pid=adapter.tasks.get('real-cancel').worker.pid;const cancelled=await adapter.cancel({taskId:'real-cancel'});assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.stopped,true);assert.throws(()=>process.kill(pid,0));assert.ok(!(await adapter.status({taskId:'real-cancel'})).artifact);assert.ok(existsSync(sourceFile));assert.ok(existsSync(completed.outputPath));});

test('Studio browser playback, source saving, automatic refresh and shared rendering',{skip:!runtimePresent,timeout:120000},async t=>{
  const {root,adapter,events}=await fixture(t); const projectDir=path.join(root,'Studio 竖屏');
  await fs.mkdir(projectDir,{recursive:true});const platformId='project_6a513c9d-5362-49aa-a23b-e4ec937bbfd6';await fs.writeFile(path.join(projectDir,'project.json'),JSON.stringify({id:platformId,name:'平台项目',path:projectDir}));
  const created=await adapter.create({projectDir,projectId:platformId,title:'Studio 验收',orientation:'portrait',duration:2});assert.equal(created.projectId,platformId);assert.equal((JSON.parse(await fs.readFile(path.join(projectDir,'project.json'),'utf8'))).name,'平台项目');
  const urls=await adapter.preview({projectDir}); const {default:puppeteer}=await import(pathToFileURL(path.join(repo,'tools','hyperframes','node_modules','puppeteer-core','lib','puppeteer','puppeteer-core.js')));
  const browser=await puppeteer.launch({executablePath:adapter.runtime.chrome,headless:true,args:['--disable-gpu','--disable-background-networking']}); t.after(()=>browser.close());
  const page=await browser.newPage(); await page.setViewport({width:1440,height:900}); const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(urls.studioUrl,{waitUntil:'domcontentloaded'}); await page.waitForFunction(()=>document.getElementById('source').value.includes('Studio 验收'));
  await page.click('#edit');
  const getPreview=()=>page.frames().find(f=>f.url().startsWith(new URL(urls.previewUrl).origin));
  await waitFor(()=>!!getPreview());await getPreview().waitForFunction(()=>window.__playerReady===true);
  await page.evaluate(()=>{const seek=document.getElementById('seek');seek.value=1.5;seek.dispatchEvent(new Event('input'));});
  await new Promise(r=>setTimeout(r,150));
  const visible=await getPreview().evaluate(()=>({opacity:Number(getComputedStyle(document.querySelector('.title')).opacity),time:window.__player.getTime()}));assert.ok(visible.opacity>.5);assert.ok(visible.time>1.4);
  await page.click('#play');await new Promise(r=>setTimeout(r,100));assert.equal(await getPreview().evaluate(()=>window.__player.isPlaying()),true);await page.click('#play');
  await page.evaluate(()=>{const source=document.getElementById('source');source.value=source.value.replaceAll('Studio 验收','已保存的作品');source.dispatchEvent(new Event('input'));});await page.click('#save');await page.waitForFunction(()=>document.getElementById('message').textContent.includes('已保存'));
  assert.match(await fs.readFile(path.join(projectDir,'index.html'),'utf8'),/已保存的作品/);
  let source=await fs.readFile(path.join(projectDir,'index.html'),'utf8');await fs.writeFile(path.join(projectDir,'index.html'),source.replaceAll('已保存的作品','Agent 自动刷新').replace('data-duration="2"','data-duration="3"'));
  await page.waitForFunction(()=>document.getElementById('source').value.includes('Agent 自动刷新'),{timeout:10000});
  await page.waitForFunction(()=>document.getElementById('seek').max==='3');
  await waitFor(async()=>{try{return await getPreview()?.evaluate(()=>document.querySelector('.title')?.textContent.includes('Agent 自动刷新'));}catch{return false;}},10000);
  await new Promise(r=>setTimeout(r,200));
  await page.screenshot({path:path.join(root,'Studio-desktop.png'),fullPage:true});
  await page.select('#quality','draft');await page.click('#render');await waitFor(()=>events.some(e=>e.event==='task'&&e.source==='studio'&&e.status==='complete'),60000);
  const completed=events.find(e=>e.event==='task'&&e.source==='studio'&&e.status==='complete');assert.equal(completed.projectId,platformId);assert.equal(completed.mediaValidated,true);assert.equal(completed.media.streams[0].height,1920);assert.deepEqual(errors,[]);
});

test('idleOnly stop never cancels an accepted Studio task and closes before a later start',{skip:!runtimePresent,timeout:90000},async t=>{
  const {root,adapter}=await fixture(t);const projectDir=path.join(root,'更新与Studio受理竞态');await adapter.create({projectDir,duration:1});
  const accepted=adapter.startTask({projectDir,taskId:'studio-stop-race',source:'studio',quality:'draft'});
  await assert.rejects(adapter.dispatch('stop',{idleOnly:true}),{code:'TOOL_BUSY'});
  const task=await accepted;assert.equal(task.source,'studio');assert.equal(adapter.closed,false);await task.done;assert.equal(task.status,'complete',task.error);
  assert.equal((await adapter.dispatch('stop',{idleOnly:true})).stopped,true);
  await assert.rejects(adapter.startTask({projectDir,taskId:'too-late',source:'studio'}),{code:'TOOL_CLOSED'});
  assert.equal(adapter.tasks.has('too-late'),false);
});

test('task-record failure releases the render slot and can recover',{skip:!runtimePresent,timeout:90000},async t=>{
  const{root,adapter}=await fixture(t);const projectDir=path.join(root,'记录失败');await adapter.create({projectDir,duration:1});
  await fs.writeFile(path.join(projectDir,'.mediahub'),'a file cannot be a task directory');
  await assert.rejects(adapter.render({projectDir,taskId:'record-failure'}));assert.equal(adapter.activeTask,null);assert.equal(adapter.renderStarting,false);assert.equal((await adapter.status({taskId:'record-failure'})).status,'failed');
  await fs.unlink(path.join(projectDir,'.mediahub'));await adapter.render({projectDir,taskId:'record-recovered',quality:'draft'});await waitFor(()=>!adapter.activeTask);assert.equal((await adapter.status({taskId:'record-recovered'})).status,'complete');assert.equal((await adapter.shutdown({idleOnly:true})).stopped,true);
});

test('Studio legacy cancel waits for pending task acceptance and unknown MP4 files stay unverified',{skip:!runtimePresent,timeout:90000},async t=>{
  const{root,adapter}=await fixture(t);const projectDir=path.join(root,'HTTP取消');const project=await adapter.create({projectDir,duration:1});const urls=await adapter.preview({projectDir});const connect=await fetch(urls.studioUrl,{redirect:'manual'});const cookie=connect.headers.get('set-cookie').split(';')[0];const origin=new URL(urls.studioUrl).origin;
  const originalProject=adapter.project.bind(adapter);adapter.project=async dir=>{await new Promise(r=>setTimeout(r,400));return originalProject(dir);};
  const started=await fetch(origin+'/api/projects/'+project.projectId+'/render',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({fps:30,format:'mp4',quality:'draft'})});const{jobId}=await started.json();
  const response=await fetch(origin+'/api/render/'+jobId+'/cancel',{method:'POST',headers:{cookie,origin}});const cancelled=await response.json();assert.equal(response.status,200,JSON.stringify(cancelled));assert.equal(cancelled.stopped,true);assert.equal(cancelled.status,'cancelled');assert.equal((await adapter.status({taskId:jobId})).status,'cancelled');assert.equal(adapter.activeTask,null);
  await fs.writeFile(path.join(projectDir,'renders','unknown.mp4'),'this is not a movie');assert.equal((await fetch(origin+'/api/projects/'+project.projectId+'/renders',{headers:{cookie}})).status,404);
  await adapter.render({projectDir,taskId:'agent-render',quality:'draft'});const busy=await fetch(origin+'/api/projects/'+project.projectId+'/render',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({fps:30,format:'mp4'})});assert.equal(busy.status,409);assert.equal((await busy.json()).code,'RENDER_BUSY');await adapter.cancel({taskId:'agent-render'});
});

test('render CSP still isolates projects without a head tag',{skip:!runtimePresent,timeout:90000},async t=>{
  const http=require('node:http');let requests=0;const server=http.createServer((_req,res)=>{requests++;res.end('not permitted');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const{root,adapter}=await fixture(t);const projectDir=path.join(root,'没有head');const project=await adapter.create({projectDir,duration:1});let source=await fs.readFile(project.entry,'utf8');source=source.replace('<head>','').replace('</head>','').replace('</body>',`<script>fetch('http://127.0.0.1:${server.address().port}/offline-leak').catch(()=>{});</script></body>`);await fs.writeFile(project.entry,source);assert.equal((await adapter.lint({projectDir})).ok,true);
  await adapter.render({projectDir,taskId:'no-head',quality:'draft'});await waitFor(()=>!adapter.activeTask);assert.equal((await adapter.status({taskId:'no-head'})).status,'complete');assert.equal(requests,0,'The authored script must not reach another origin');
});

test('normal and forced cancellation reclaim the full owned process tree while another process survives',{skip:!runtimePresent||process.platform!=='win32',timeout:180000},async t=>{
  const{spawn,execFile}=require('node:child_process');const{promisify}=require('node:util');const exec=promisify(execFile);const{root,adapter}=await fixture(t);adapter.cancelTimeoutMs=100;
  const sentinel=spawn(adapter.runtime.node,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});t.after(()=>sentinel.kill('SIGKILL'));
  const snapshot=async()=>{const{stdout}=await exec(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'],{windowsHide:true,timeout:20000,maxBuffer:8*1024*1024});return JSON.parse(stdout);};
  const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
  const projectDir=path.join(root,'进程树 真实验收');await adapter.create({projectDir,duration:40});const reports=[];
  for(const mode of ['normal','forced']){
    adapter.cancelTimeoutMs=mode==='forced'?100:15000;
    await adapter.render({projectDir,taskId:'tree-'+mode,quality:'draft'});await waitFor(()=>adapter.tasks.get('tree-'+mode).progress>=27);
    const worker=adapter.tasks.get('tree-'+mode).worker;let backstopUsed=false;const originalKill=worker.kill.bind(worker);worker.kill=signal=>{backstopUsed=true;return originalKill(signal);};const processes=await snapshot();const owned=new Set([worker.pid]);let changed=true;while(changed){changed=false;for(const process of processes)if(owned.has(process.ParentProcessId)&&!owned.has(process.ProcessId)){owned.add(process.ProcessId);changed=true;}}
    const tree=processes.filter(p=>owned.has(p.ProcessId));assert.ok(tree.some(p=>p.Name==='chrome-headless-shell.exe'),JSON.stringify(tree));assert.ok(tree.some(p=>p.Name==='node.exe'),JSON.stringify(tree));assert.ok(!owned.has(sentinel.pid));
    if(mode==='forced')worker.stdin.write=()=>true; // Simulate an unresponsive render worker: exercise native Job backstop.
    const cancelled=await adapter.cancel({taskId:'tree-'+mode});assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.stopped,true);await waitFor(()=>[...owned].every(pid=>!alive(pid)),10000);assert.equal(alive(sentinel.pid),true);
    assert.equal(backstopUsed,mode==='forced');reports.push({mode,backstopUsed,descendants:tree.map(p=>p.Name),ownedProcessCount:owned.size,remainingOwned:0,unrelatedSentinelAlive:true,status:cancelled.status});
  }
  await fs.writeFile(path.join(root,'process-tree-acceptance.json'),JSON.stringify(reports,null,2));
});
