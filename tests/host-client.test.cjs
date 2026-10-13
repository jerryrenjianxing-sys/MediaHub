'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HyperframesClient } = require('../desktop/hyperframes-client.cjs');
const helper = path.join(__dirname, '../build/native/mediahub-pipe.exe');
const skip = process.platform !== 'win32' || !fs.existsSync(helper);
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'MediaHub client '));
  fs.mkdirSync(path.join(root, 'runtime/node'), { recursive: true }); fs.copyFileSync(process.execPath, path.join(root, 'runtime/node/node.exe'));
  fs.writeFileSync(path.join(root, 'service-entry.mjs'), `import readline from 'node:readline';const send=o=>process.stdout.write(JSON.stringify(o)+'\\n');const jobs=new Map();readline.createInterface({input:process.stdin}).on('line',line=>{const {id,method,params}=JSON.parse(line);if(method==='status'){send({id,result:params.taskId?{status:jobs.get(params.taskId)?.status||'not-found'}:{healthy:true}});}if(method==='render'){const taskId=params.taskId;const job={status:'rendering'};jobs.set(taskId,job);send({event:'task',id:taskId,taskId,status:'queued',source:'agent'});if(!params.unknownReceipt)send({id,result:{accepted:true,taskId}});job.timer=setTimeout(()=>{send({event:'progress',taskId,progress:57,stage:'capture'});job.status='complete';send({event:'task',id:taskId,taskId,status:'complete',mediaValidated:true,outputPath:'example.mp4'});},120);}if(method==='cancel'){const job=jobs.get(params.taskId);clearTimeout(job?.timer);if(job)job.status='cancelled';send({event:'task',id:params.taskId,taskId:params.taskId,status:'cancelled'});send({id,result:{status:'cancelled',stopped:true}});}if(method==='shutdown'){if(params.idleOnly&&[...jobs.values()].some(j=>j.status==='rendering')){send({id,error:{code:'TOOL_BUSY',message:'busy'}});return;}send({id,result:{stopped:true}});setTimeout(()=>process.exit(0),10);}});`);
  const client = new HyperframesClient({ helperPath: helper }); await client.start(root);
  t.after(async () => { await client.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return client;
}
test('NDJSON task events with id are distinct from RPC replies and completion is normalized', { skip }, async t => {
  const client = await fixture(t); const progress = [];
  const receipt = await client.invoke('render', {}, { taskId: 'task-normal', progress: p => progress.push(p) });
  assert.equal(receipt.status, 'completed'); assert.equal(client.busy, false); assert.equal(progress[0].percent, 57);
});
test('unknown acceptance receipt is queried without replay and remains busy until terminal event', { skip }, async t => {
  const client = await fixture(t); const request = client.request.bind(client); let renders = 0;
  client.request = (method, params, timeout) => { if (method === 'render') { renders++; return request(method, params, 15); } return request(method, params, timeout); };
  const pending = client.invoke('render', { unknownReceipt: true }, { taskId: 'task-unknown' });
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(client.busy, true);
  await assert.rejects(client.stop({ idleOnly: true }), { code: 'TOOL_BUSY' });
  assert.equal((await pending).status, 'completed'); assert.equal(renders, 1); assert.equal(client.busy, false);
});
