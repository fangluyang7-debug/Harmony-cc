const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{transformSync}=require('esbuild');
function client(values=new Map(),nextSeq=1){
 const calls=[],messages=[];let fail=false,previewFail=false,rejected=false;
 const store={get:async(k,fallback)=>values.has(k)?values.get(k):fallback,put:async(k,v)=>values.set(k,v),flush:async()=>{}};
 const http={RequestMethod:{POST:'POST'},createHttp:()=>({request:async(url,options)=>{calls.push({url,body:JSON.parse(options.extraData)});if(fail)throw Error('offline');return {responseCode:rejected?403:200,result:JSON.stringify({displayOnly:true,nextSeq})};},destroy(){}})};
 const image={createImageSource:()=>{if(previewFail)throw Error('preview failed');return {createPixelMap:async()=>({release:async()=>{}}),release:async()=>{}};},createImagePacker:()=>({packing:async()=>new Uint8Array([7]).buffer,release:async()=>{}})};
 const m={exports:{}},code=transformSync(fs.readFileSync('apps/harmony-photo/entry/src/main/ets/PhotoDisplay.ets','utf8'),{loader:'ts',format:'cjs'}).code;
 new Function('require','module','exports',code)(name=>name==='@kit.ArkData'?{preferences:{getPreferences:async()=>store}}:name==='@kit.NetworkKit'?{http}:name==='@kit.ImageKit'?{image}:name==='scheduler'?{factory:{id:()=> 'run'},hash:()=> 'original-hash',base64:{encodeToStringSync:b=>Buffer.from(b).toString('base64')}}:{readPhoto:()=>new Uint8Array([1,2,3])},m,m.exports);
 return {value:new m.exports.PhotoDisplay(s=>messages.push(s)),calls,messages,fail:()=>{fail=true;},recover:()=>{fail=false;rejected=false;},reject:()=>{rejected=true;},previewFail:()=>{previewFail=true;}};
}
const invitation='http://192.168.1.2:7460/#display='+'a'.repeat(36);
test('display reports ordered events with thumbnail, never uploads original input or submits compute',async()=>{
 const c=client();await c.value.connect(invitation);await c.value.select([{path:'/phone',name:'photo',width:192,height:128}]);c.value.start();c.value.progress(0,'AI 高清增强',1,4);c.value.finish(100);await c.value.queue;
 assert.deepEqual(c.calls.slice(1).map(x=>x.body.type),['SELECTED','START','PROGRESS','FINISH']);
 assert.deepEqual(c.calls.slice(1).map(x=>x.body.seq),[1,2,3,4]);
 assert.equal(c.calls[1].body.inputs[0].preview,'data:image/jpeg;base64,Bw==');
 assert.ok(c.calls.every(x=>/\/(connect|event)$/.test(x.url)));
 assert.ok(!JSON.stringify(c.calls).includes('AQID'));
});
test('display failure retries once then drops queued progress without failing local work',async()=>{
 const c=client();await c.value.connect(invitation);c.fail();c.value.start();for(let i=0;i<100;i++)c.value.progress(0,'enhance',i,100);c.value.finish(1000);await c.value.queue;
 assert.equal(c.calls.length,3);assert.match(c.messages.at(-1),/本机处理继续/);
 await c.value.disconnect();assert.equal(c.value.connected(),false);
});
test('thumbnail preparation failure is contained in display channel',async()=>{
 const c=client();await c.value.connect(invitation);c.previewFail();await c.value.select([{path:'/phone',width:192,height:128}]);c.value.start();await c.value.queue;
 assert.equal(c.calls.length,1);assert.match(c.messages.at(-1),/本机处理仍可继续/);
});
test('display pairing survives app recreation, resumes sequence, and explicit disconnect forgets it',async()=>{
 const values=new Map(),first=client(values);assert.equal(await first.value.restore({}),'');assert.equal(first.calls.length,0);
 await first.value.connect(invitation);assert.equal(values.get('invitation'),invitation);
 const reopened=client(values,42);assert.equal(await reopened.value.restore({}),invitation);assert.equal(reopened.value.connected(),true);
 await reopened.value.select([{path:'/phone',name:'photo',width:192,height:128}]);await reopened.value.queue;assert.equal(reopened.calls[1].body.seq,42);
 await reopened.value.disconnect();const third=client(values);await third.value.restore({});assert.equal(third.calls.length,0);assert.equal(third.value.connected(),false);
});
test('unavailable or reset display never reports restored connection or prevents local use',async()=>{
 for(const kind of ['fail','reject']){const values=new Map([['invitation',invitation]]),c=client(values);c[kind]();assert.equal(await c.value.restore({}),invitation);assert.equal(c.value.connected(),false);assert.match(c.messages.at(-1),/未连接/);assert.equal(values.get('invitation'),invitation);c.value.start();await c.value.queue;assert.equal(c.calls.length,1);}
});
test('a failed startup connection recovers at the next run boundary and sends real stages',async()=>{
 const c=client(new Map([['invitation',invitation]]),20);c.fail();await c.value.restore({});c.recover();
 await c.value.resume();assert.equal(c.value.connected(),true);
 await c.value.select([{path:'/phone',name:'photo',width:192,height:128}]);c.value.start();
 for(const stage of ['分析照片','准备图块 1/1','AI 高清增强 1/1','合成并校验','生成高清成品'])c.value.progress(0,stage,1,7);
 c.value.result(0,JSON.stringify({image:'result'}));c.value.finish(100);await c.value.queue;
 const events=c.calls.filter(x=>x.url.endsWith('/event')).map(x=>x.body);
 assert.deepEqual(events.map(x=>x.type),['SELECTED','START',...Array(5).fill('PROGRESS'),'RESULT','FINISH']);assert.equal(events[0].seq,20);
 assert.ok(events.every((x,i)=>x.seq===20+i));
});
test('coordinator display inheritance creates no local round until local selection; manual disconnect stays disconnected',async()=>{
 const values=new Map(),c=client(values);await c.value.restore({});await c.value.resume(invitation);
 assert.deepEqual(c.calls.map(x=>x.url),['http://192.168.1.2:7460/connect']);
 await c.value.resume();assert.equal(c.calls.length,1);assert.equal(values.get('invitation'),invitation);
 await c.value.disconnect();await c.value.resume(invitation);assert.equal(c.calls.length,1);
 const reopened=client(values);await reopened.value.restore({});await reopened.value.resume(invitation);assert.equal(reopened.calls.length,0);
 await reopened.value.connect(invitation);assert.equal(reopened.value.canAutoConnect(),true);
});
test('recovering after transport failure resynchronizes sequence before a new selected/start pair',async()=>{
 const c=client();await c.value.connect(invitation);c.fail();c.value.start();await c.value.queue;assert.equal(c.value.connected(),false);
 c.recover();await c.value.resume();await c.value.select([{path:'/phone',name:'photo',width:192,height:128}]);c.value.start();await c.value.queue;
 assert.deepEqual(c.calls.slice(-2).map(x=>[x.body.type,x.body.seq]),[['SELECTED',1],['START',2]]);
});
