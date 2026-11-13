const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {startDisplay}=require('../../scripts/photo-display-server.cjs');
const {PhotoCoordinatorObserver}=require('../../scripts/photo-display-coordinator.cjs');
const uuid='12345678-1234-1234-1234-123456789abc';
test('completed phone round and invitation survive service restart; reset hides old rounds without deleting receipts',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'photo-display-')),state={runId:uuid,revision:8,generation:0,seq:8,receivedAt:Date.now()-100,status:'SUCCEEDED',inputs:[{hash:'a'.repeat(64),width:1,height:1,preview:'data:image/jpeg;base64,YQ=='}],results:[],events:[],durationMs:1200};
 fs.writeFileSync(path.join(dir,'session.json'),JSON.stringify({key:'test-key',state}));
 const a=await startDisplay({host:'127.0.0.1',port:0,dataDir:dir});await new Promise(resolve=>a.server.close(resolve));
 const b=await startDisplay({host:'127.0.0.1',port:0,dataDir:dir});t.after(()=>b.server.close());
 assert.match((await(await fetch(b.url+'session')).json()).invitation,/test-key$/);
 let data=await(await fetch(b.url+'runs')).json();assert.equal(data.runs.length,1);assert.equal(data.runs[0].durationMs,1200);
 const image=await fetch(b.url+'images/'+encodeURIComponent('local:'+uuid)+'/0/input');assert.equal(await image.text(),'a');
 await fetch(b.url+'event',{method:'POST',headers:{'X-Display-Key':'test-key'},body:JSON.stringify({seq:9,type:'PICKING',runId:uuid})});
 data=await(await fetch(b.url+'runs')).json();assert.equal(data.runs.filter(r=>r.state==='SUCCEEDED').length,1,'picking the next round preserves the completed baseline');assert.equal(data.runs.filter(r=>r.state==='PICKING').length,1);
 await fetch(b.url+'reset',{method:'POST',headers:{Origin:new URL(b.url).origin,'X-Display-Reset':'1'}});
 data=await(await fetch(b.url+'runs')).json();assert.equal(data.runs.length,0);assert.equal(fs.existsSync(path.join(dir,'run-'+uuid+'.json')),true);
 assert.equal((await fetch(b.url+'runs/'+encodeURIComponent('local:'+uuid))).status,400);
});
test('coordinator observer obtains launcher session and reads receipts without submission or credential disclosure',async t=>{
 const calls=[];const server=http.createServer((req,res)=>{calls.push(req.method+' '+req.url);res.setHeader('Content-Type','application/json');
 if(req.url==='/console/session'){assert.equal(req.headers['x-runtime-token'],'b'.repeat(64));res.setHeader('Set-Cookie','local=private; HttpOnly');return res.end('{}');}
 assert.equal(req.headers.cookie,'local=private');assert.equal(req.method,'GET');
 if(req.url==='/v2/spaces/me')return res.end(JSON.stringify({spaces:[{id:uuid,name:'test'}]}));
 if(req.url.endsWith('/directory'))return res.end('{"devices":[]}');
 if(req.url.endsWith('/photo-runs'))return res.end(JSON.stringify([{id:uuid}]));
 res.end(JSON.stringify({id:uuid,state:'SUCCEEDED'}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const o=new PhotoCoordinatorObserver(),origin='http://127.0.0.1:'+server.address().port;
 await assert.rejects(o.connect('http://example.com/#'+'b'.repeat(64)));
 await o.connect(origin+'/#'+'b'.repeat(64));assert.equal((await o.run(uuid)).state,'SUCCEEDED');assert.equal(o.status().connected,true);assert.doesNotMatch(JSON.stringify(o.status()),/private|bbbb/);assert.equal(calls.filter(c=>c.startsWith('POST')).length,1);
});
test('comparison rejects different inputs, unknown metadata, failures and simulated rounds',async()=>{
 const {comparison}=await import('../../apps/team-space-web/photo-display-compare.mjs');
 const a={kind:'LOCAL',state:'SUCCEEDED',inputs:[{originalHash:'a',width:2,height:2}],budgetMs:180000,model:{weightsHash:'weights'},scale:4,durationMs:100};
 assert.equal(comparison(a,{...a,durationMs:50}).ratio,2);
 for(const change of [{inputs:[]},{budgetMs:null},{model:null},{state:'FAILED'},{kind:'SIMULATED'},{scale:2}])assert.equal(comparison(a,{...a,...change}).ratio,undefined);
});

test('history excludes draft-only events and lists actual participating devices',async()=>{
 const {displayRounds,roundDevices}=await import('../../apps/team-space-web/photo-display-compare.mjs');
 const done={id:'a',kind:'COOPERATIVE',state:'SUCCEEDED',createdAt:10,devices:[{id:'phone',name:'手机'},{id:'B',name:'设备 B'}]},draft={id:'b',kind:'LOCAL',state:'SELECTED',createdAt:11};
 assert.deepEqual(displayRounds({runs:[draft,done]}),{runs:[done],preview:draft});assert.equal(roundDevices(done),'手机 · 设备 B');
 assert.equal(displayRounds({runs:[done],preview:{...draft,createdAt:9}}).preview,undefined);
 assert.equal(roundDevices({kind:'COOPERATIVE',devices:[]}),'等待执行回执');assert.equal(roundDevices({kind:'LOCAL',devices:[]}),'手机 CPU');
});
