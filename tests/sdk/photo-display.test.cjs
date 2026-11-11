const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),sharp=require('sharp');
const {startDisplay,createDisplayState}=require('../../scripts/photo-display-server.cjs');
test('display-only HTTP receiver connects without coordinator and never exposes job dispatch',async t=>{
 const r=await startDisplay({host:'127.0.0.1',port:0});t.after(()=>r.server.close());const session=await(await fetch(r.url+'session')).json(),key=session.invitation.split('display=')[1];
 assert.equal(session.displayOnly,true);assert.equal((await fetch(r.url+'v2/sdk/jobs')).status,404);
 const post=(route,event,keyValue=key)=>fetch(r.url+route,{method:'POST',headers:{'Content-Type':'application/json','X-Display-Key':keyValue},body:JSON.stringify(event)});
 assert.equal((await post('connect',{},'wrong')).status,403);assert.equal((await(await post('connect',{})).json()).displayOnly,true);
 const input={name:'phone photo',width:1,height:1,hash:'a'.repeat(64),preview:'data:image/jpeg;base64,YQ=='};
 assert.equal((await post('event',{seq:1,type:'SELECTED',runId:'r',inputs:[input]})).status,200);
 assert.equal((await post('event',{seq:2,type:'START',runId:'r'})).status,200);
 assert.equal((await post('event',{seq:3,type:'FINISH',runId:'r',durationMs:10})).status,400,'cannot announce completion without actual products');
 const png=await sharp({create:{width:4,height:4,channels:3,background:'#267cba'}}).png().toBuffer(),product={format:'png',width:4,height:4,image:png.toString('base64'),hash:crypto.createHash('sha256').update(png).digest('hex')};
 assert.equal((await post('event',{seq:3,type:'RESULT',runId:'r',imageIndex:0,product:{...product,hash:'invalid'}})).status,400);
 const event={seq:3,type:'RESULT',runId:'r',imageIndex:0,product};assert.equal((await post('event',event)).status,200);assert.equal((await post('event',event)).status,200,'retry is idempotent');
 assert.equal((await post('event',{seq:4,type:'FINISH',runId:'r',durationMs:1234})).status,200);
 const evidence=await(await fetch(r.url+'evidence')).json();assert.equal(evidence.windowsCompute,false);assert.equal(evidence.results.length,1);assert.equal(evidence.status,'SUCCEEDED');assert.equal(evidence.results[0].image,undefined);assert.equal(evidence.inputs[0].preview,undefined);assert.equal(evidence.executionEvidence,'SOURCE_APP_REPORTED');
});
test('stale or foreign runs cannot overwrite current display products',()=>{
 const s=createDisplayState();s.apply({seq:1,type:'SELECTED',runId:'new',inputs:[]});assert.throws(()=>s.apply({seq:2,type:'PROGRESS',runId:'old',total:1,completed:0}),/RUN_MISMATCH/);assert.equal(s.get().runId,'new');assert.equal(s.get().seq,1);
});
test('reset clears records, invalidates old uploads and allows a fresh phone connection',async t=>{
 const r=await startDisplay({host:'127.0.0.1',port:0});t.after(()=>r.server.close());
 const before=await(await fetch(r.url+'session')).json(),key=before.invitation.split('display=')[1];
 const event={seq:1,type:'SELECTED',runId:'old',inputs:[{name:'photo',width:1,height:1,hash:'a'.repeat(64),preview:'data:image/jpeg;base64,YQ=='}]};
 const post=(route,body,k=key)=>fetch(r.url+route,{method:'POST',headers:{'X-Display-Key':k,'Content-Type':'application/json'},body:JSON.stringify(body)});
 await post('event',event);
 assert.equal((await fetch(r.url+'reset',{method:'POST'})).status,403);
 assert.equal((await fetch(r.url+'reset',{method:'POST',headers:{Origin:'https://foreign.invalid','X-Display-Reset':'1'}})).status,403);
 // Hold an authenticated request open across reset; its late body must not revive the run.
 const http=require('node:http');let finish;
 const late=new Promise(resolve=>{const q=http.request(r.url+'event',{method:'POST',headers:{'X-Display-Key':key,'Content-Type':'application/json'}},res=>{res.resume();resolve(res.statusCode);});q.write('{');finish=()=>q.end(JSON.stringify({...event,seq:2}).slice(1));});
 const reset=await fetch(r.url+'reset',{method:'POST',headers:{Origin:new URL(r.url).origin,'X-Display-Reset':'1'}});assert.equal(reset.status,200);
 const after=await reset.json();finish();assert.equal(await late,403);
 assert.notEqual(before.invitation,after.invitation);assert.equal(after.generation,1);
 assert.equal(after.state.connected,false);assert.equal(after.state.status,'WAITING');assert.equal(after.state.seq,0);
 assert.deepEqual(after.state.inputs,[]);assert.deepEqual(after.state.results,[]);assert.deepEqual(after.state.events,[]);assert.equal(after.state.durationMs,undefined);
 assert.equal((await post('connect',{})).status,403);assert.equal((await post('event',event)).status,403);
 const freshKey=after.invitation.split('display=')[1];assert.equal((await(await post('connect',{},freshKey)).json()).nextSeq,1);
 assert.equal((await post('event',{...event,runId:'new'},freshKey)).status,200);
 const state=await(await fetch(r.url+'state')).json();assert.equal(state.runId,'new');assert.ok(state.revision>after.state.revision);
});
