const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{transformSync}=require('esbuild');
function load(file,dependencies){const m={exports:{}};new Function('require','module','exports',transformSync(fs.readFileSync('apps/harmony-photo/entry/src/main/ets/'+file,'utf8'),{loader:'ts',format:'cjs'}).code)(name=>dependencies[name]??{},m,m.exports);return m.exports;}
test('native photo DAG matches the existing web planner for edges and non-square images',async()=>{
 const native=load('PhotoWorkflow.ets',{}),web=await import('../../apps/team-space-web/photo-workflow.mjs');
 for(const [w,h] of [[1,1],[96,64],[192,128],[333,217],[1920,500]]){
  const input={contentHash:'a'.repeat(64),bytes:77,schemaId:'image.raster',schemaVersion:1},expected=web.photoWorkflow('task',input,w,h).workflow;
  for(const node of expected.nodes)if(!node.id.startsWith('enhance-'))node.executionScope='ORIGIN_DEVICE';
  assert.deepEqual(native.photoWorkflow('task',input,w,h),expected);
 }
 assert.throws(()=>native.photoWorkflow('task',{},2000,2000));
});
for(const fault of ['none','cancel','result-timeout','capture-timeout','update-timeout'])test('native batch recovers '+fault+' without duplicate submission',async()=>{
 const stopBeforeReady=fault==='cancel';let injected=false,cancellations=0;
 const events=[],results=[];let counter=0,run,elapsed=0,active=0,peak=0;
 const scheduler={factory:{id:()=>`job-${++counter}`},hash:()=> 'a'.repeat(64),base64:{encodeToStringSync:b=>Buffer.from(b).toString('base64')},text:b=>Buffer.from(b).toString(),monotonic:()=>elapsed,SchedulerSdk:class{
  constructor(port){this.port=port;}
  async registerInput(data){events.push('register-input');return {contentHash:'a'.repeat(64),bytes:data.length,schemaId:'image.raster',schemaVersion:1};}
  async submit(graph,options){assert.equal(options.budgetMs,174000);assert.equal(options.inputLocation,'ORIGIN');events.push('submit');const port=this.port;return {id:options.requestId,cancel:async()=>{cancellations++;},result:async()=>{active++;peak=Math.max(peak,active);try{await new Promise(r=>setTimeout(r,60));if(fault==='result-timeout'&&options.requestId==='job-4'&&!injected){injected=true;throw Error('Operation timeout');}await port.capture();return {output:Buffer.from('{}')};}finally{active--;}}};}
  releaseInput(){events.push('release');}resume(){return {cancel:async()=>{}};}
 }};
 const photoSession={batchConcurrency:async()=>4,requireReady:async()=>{elapsed=17000;if(stopBeforeReady)throw Error('已取消');events.push('ready');},workflowPort:(cancelled,capture)=>({capture}),request:async(_url,encoded)=>{
  const m=JSON.parse(encoded);events.push(m.method+':'+m.route);
  if(m.route==='/photo-runs'){run={id:'run',revision:0,jobs:[],state:'PREPARING'};return JSON.stringify(run);}
  if(m.route.includes('capture-result')){const i=Number(m.route.split('=')[1]);assert.ok(run.jobs.some(j=>j.imageIndex===i),'job linked before capture');if(fault==='capture-timeout'&&i===3&&!injected){injected=true;throw Error('PHOTO_DISPLAY_CAPTURE: Operation timeout');}return '{}';}
  if(m.method==='PUT')return '{}';
  if(m.method==='POST'){assert.equal(m.body.revision,run.revision);await new Promise(r=>setTimeout(r,3));run={...run,...m.body,revision:run.revision+1};if(fault==='update-timeout'&&m.body.deliveredImage&&!injected){injected=true;throw Error('Operation timeout');}}
  return JSON.stringify(run);
 }};
 const image={createImageSource:()=>({createPixelMap:async()=>({release:async()=>{}}),release:async()=>{}}),createImagePacker:()=>({packing:async()=>{elapsed+=1000;return new Uint8Array([3,4]).buffer;},release:async()=>{}})};
 const workflow=load('PhotoWorkflow.ets',{}),{PhotoBatch}=load('PhotoBatch.ets',{'scheduler':scheduler,'@kit.ImageKit':{image},'./PhotoSession':{photoSession},'./PhotoRecovery':load('PhotoRecovery.ets',{}),'./PhotoWorkflow':workflow,'./PhotoFiles':{readPhoto:()=>new Uint8Array([1,2]),storePhotoResult:async(_c,_b,name)=>({id:name,name,width:384,height:256})}});
 const batch=new PhotoBatch();assert.equal(events.length,0);
 let duration;
 const running=batch.run({},[0,1,2,3,4,5].map(i=>({name:'照片 '+i,path:'phone-only-'+i,width:96,height:64})),{cancelled:()=>stopBeforeReady&&elapsed>0,started:()=>events.push('started'),duration:ms=>duration=ms,progress:()=>{},result:(i,r)=>results.push([i,r.name])});
 if(stopBeforeReady){await assert.rejects(running,/已取消/);assert.equal(run,undefined);assert.equal(duration,undefined);assert.equal(events.includes('started'),false);assert.equal(events.includes('submit'),false);assert.equal(events.includes('register-input'),false);assert.equal(results.length,0);return;}
 assert.equal(await running,6000);assert.equal(duration,6000);assert.equal(run.sourceDurationMs,6000,'preparation is included; the preceding readiness check is not');
 assert.equal(cancellations,0);if(fault!=='none')assert.equal(injected,true);assert.equal(peak,4,'six images fill four worker slots without dispatching all six at once');assert.equal(run.state,'SUCCEEDED');assert.equal(run.jobs.length,6);assert.equal(new Set(run.jobs.map(j=>j.imageIndex)).size,6);assert.equal(results.length,6);assert.equal(events.filter(e=>e==='submit').length,6);
 assert.ok(events.indexOf('POST:/photo-runs')<events.indexOf('register-input'));
 assert.ok(events.indexOf('ready')<events.indexOf('register-input'));
 assert.ok(events.indexOf('ready')<events.indexOf('started'));assert.ok(events.indexOf('started')<events.indexOf('POST:/photo-runs'));
});

test('result recovery respects cancellation, original remaining budget and integrity errors',async()=>{
 const {recoverPhotoDelivery}=load('PhotoRecovery.ets',{});let calls=0;
 await assert.rejects(recoverPhotoDelivery(async()=>{calls++;throw Error('Operation timeout');},()=>100,()=>false,()=>{}),/timeout/);assert.equal(calls,1);
 await assert.rejects(recoverPhotoDelivery(async()=>{calls++;},()=>1000,()=>true,()=>{}),/已取消/);assert.equal(calls,1);
 await assert.rejects(recoverPhotoDelivery(async()=>{calls++;throw Error('SDK_OUTPUT_INTEGRITY');},()=>1000,()=>false,()=>{}),/INTEGRITY/);assert.equal(calls,2);
});
