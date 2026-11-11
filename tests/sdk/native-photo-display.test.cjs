const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{transformSync}=require('esbuild');
function client(values=new Map(),nextSeq=1){
 const calls=[],messages=[];let fail=false,previewFail=false,rejected=false;
 const store={get:async(k,fallback)=>values.has(k)?values.get(k):fallback,put:async(k,v)=>values.set(k,v),flush:async()=>{}};
 const http={RequestMethod:{POST:'POST'},createHttp:()=>({request:async(url,options)=>{calls.push({url,body:JSON.parse(options.extraData)});if(fail)throw Error('offline');return {responseCode:rejected?403:200,result:JSON.stringify({displayOnly:true,nextSeq})};},destroy(){}})};
 const image={createImageSource:()=>{if(previewFail)throw Error('preview failed');return {createPixelMap:async()=>({release:async()=>{}}),release:async()=>{}};},createImagePacker:()=>({packing:async()=>new Uint8Array([7]).buffer,release:async()=>{}})};
 const m={exports:{}},code=transformSync(fs.readFileSync('apps/harmony-photo/entry/src/main/ets/PhotoDisplay.ets','utf8'),{loader:'ts',format:'cjs'}).code;
 new Function('require','module','exports',code)(name=>name==='@kit.ArkData'?{preferences:{getPreferences:async()=>store}}:name==='@kit.NetworkKit'?{http}:name==='@kit.ImageKit'?{image}:name==='scheduler'?{factory:{id:()=> 'run'},hash:()=> 'original-hash',base64:{encodeToStringSync:b=>Buffer.from(b).toString('base64')}}:{readPhoto:()=>new Uint8Array([1,2,3])},m,m.exports);
 return {value:new m.exports.PhotoDisplay(s=>messages.push(s)),calls,messages,fail:()=>{fail=true;},reject:()=>{rejected=true;},previewFail:()=>{previewFail=true;}};
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
