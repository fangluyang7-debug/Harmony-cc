const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const displayModule=require('../../scripts/photo-display-server.cjs');
const {main}=require('../../scripts/runtime-desktop.cjs');

test('display open retries failed startup without restarting coordinator or losing records',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'photo-display-recovery-'));
 const id='11111111-1111-4111-8111-111111111111';
 const record={runId:id,revision:1,generation:0,seq:1,receivedAt:Date.now(),status:'SUCCEEDED',inputs:[],results:[],events:[],durationMs:1234};
 fs.writeFileSync(path.join(dir,'run-'+id+'.json'),JSON.stringify(record));
 let starts=0;const realStart=displayModule.startDisplay;
 t.mock.method(displayModule,'startDisplay',async options=>{
  if(++starts===1)throw Object.assign(Error('ENOSPC: no space left on device'),{code:'ENOSPC'});
  return realStart({...options,host:'127.0.0.1',port:0,dataDir:dir});
 });
 const runtime=await main({openBrowser:false,role:'center'});
 t.after(async()=>{if(runtime.display)await new Promise(resolve=>runtime.display.server.close(resolve));await new Promise(resolve=>runtime.server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
 assert.equal(runtime.display,null);assert.match(runtime.control.logs[0],/ENOSPC/);
 const url=new URL(runtime.url),post=()=>fetch(url.origin+'/display/open',{method:'POST',headers:{Origin:url.origin,'X-Runtime-Token':url.hash.slice(1),'Content-Type':'application/json'},body:'{}'});
 const response=await post();assert.equal(response.status,200);const opened=await response.json();
 assert.equal((await fetch(opened.url)).status,200);assert.equal(starts,2);
 const records=await(await fetch(opened.url+'runs')).json();assert.equal(records.runs[0].durationMs,1234);
 assert.equal((await post()).status,200);assert.equal(starts,2,'reuse live service');
 assert.equal(runtime.control.state,'STOPPED');assert.equal(runtime.control.child,null,'display recovery does not launch or restart compute');
});
