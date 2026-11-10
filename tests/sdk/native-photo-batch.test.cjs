const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{transformSync}=require('esbuild');
function load(file,dependencies){const m={exports:{}};new Function('require','module','exports',transformSync(fs.readFileSync('apps/harmony-photo/entry/src/main/ets/'+file,'utf8'),{loader:'ts',format:'cjs'}).code)(name=>dependencies[name]??{},m,m.exports);return m.exports;}
test('native photo DAG matches the existing web planner for edges and non-square images',async()=>{
 const native=load('PhotoWorkflow.ets',{}),web=await import('../../apps/team-space-web/photo-workflow.mjs');
 for(const [w,h] of [[1,1],[96,64],[192,128],[333,217],[1920,500]]){
  const input={contentHash:'a'.repeat(64),bytes:77,schemaId:'image.raster',schemaVersion:1};assert.deepEqual(native.photoWorkflow('task',input,w,h),web.photoWorkflow('task',input,w,h).workflow);
 }
 assert.throws(()=>native.photoWorkflow('task',{},2000,2000));
});
test('native batch serializes concurrent job links, retains output, and delivers every selected image without preloading',async()=>{
 const events=[],results=[];let counter=0,run;
 const scheduler={factory:{id:()=>`job-${++counter}`},hash:()=> 'a'.repeat(64),base64:{encodeToStringSync:b=>Buffer.from(b).toString('base64')},text:b=>Buffer.from(b).toString(),monotonic:()=>performance.now(),SchedulerSdk:class{
  constructor(port){this.port=port;}
  async registerInput(data){events.push('register-input');return {contentHash:'a'.repeat(64),bytes:data.length,schemaId:'image.raster',schemaVersion:1};}
  async submit(graph,options){assert.ok(options.budgetMs<=180000&&options.budgetMs>0);events.push('submit');const port=this.port;return {id:options.requestId,cancel:async()=>{},result:async()=>{await port.capture();return {output:Buffer.from('{}')};}};}
  releaseInput(){events.push('release');}resume(){return {cancel:async()=>{}};}
 }};
 const photoSession={workflowPort:(cancelled,capture)=>({capture}),request:async(_url,encoded)=>{
  const m=JSON.parse(encoded);events.push(m.method+':'+m.route);
  if(m.route==='/photo-runs'){run={id:'run',revision:0,jobs:[],state:'PREPARING'};return JSON.stringify(run);}
  if(m.route.includes('capture-result')){const i=Number(m.route.split('=')[1]);assert.ok(run.jobs.some(j=>j.imageIndex===i),'job linked before capture');return '{}';}
  if(m.method==='PUT')return '{}';
  if(m.method==='POST'){assert.equal(m.body.revision,run.revision);await new Promise(r=>setTimeout(r,3));run={...run,...m.body,revision:run.revision+1};}
  return JSON.stringify(run);
 }};
 const image={createImageSource:()=>({createPixelMap:async()=>({release:async()=>{}}),release:async()=>{}}),createImagePacker:()=>({packing:async()=>new Uint8Array([3,4]).buffer,release:async()=>{}})};
 const workflow=load('PhotoWorkflow.ets',{}),{PhotoBatch}=load('PhotoBatch.ets',{'scheduler':scheduler,'@kit.ImageKit':{image},'./PhotoSession':{photoSession},'./PhotoWorkflow':workflow,'./PhotoFiles':{readPhoto:()=>new Uint8Array([1,2]),storePhotoResult:async(_c,_b,name)=>({id:name,name,width:384,height:256})}});
 const batch=new PhotoBatch();assert.equal(events.length,0);
 await batch.run({},[0,1,2].map(i=>({name:'照片 '+i,path:'phone-only-'+i,width:96,height:64})),{cancelled:()=>false,progress:()=>{},result:(i,r)=>results.push([i,r.name])});
 assert.equal(run.state,'SUCCEEDED');assert.equal(run.jobs.length,3);assert.equal(new Set(run.jobs.map(j=>j.imageIndex)).size,3);assert.equal(results.length,3);assert.equal(events.filter(e=>e==='submit').length,3);
 assert.ok(events.indexOf('POST:/photo-runs')<events.indexOf('register-input'));
});
