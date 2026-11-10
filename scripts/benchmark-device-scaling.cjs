// Real SDK benchmark: seven resource sets, identical input, budget and caller concurrency.
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),assert=require('node:assert/strict');
const {AsyncLocalStorage}=require('node:async_hooks'),{randomUUID,createHash}=require('node:crypto'),{performance}=require('node:perf_hooks');
const {SchedulerSdk}=require('@harmony/scheduler-client'),sharp=require('sharp');
const hash=b=>createHash('sha256').update(b).digest('hex');
function modes(targets){return Array.from({length:(1<<targets.length)-1},(_,i)=>i+1).map(mask=>({name:targets.filter((_,i)=>mask&(1<<i)).map(t=>t.name).join('+'),targets:targets.filter((_,i)=>mask&(1<<i))})).sort((a,b)=>a.targets.length-b.targets.length);}
// Work-list ordering only. The SDK planner still chooses all execution targets.
// A small spatial sample estimates arithmetic work; this is not a measured device cost.
function estimatedRegionWork(r){
 let total=0;
 for(let y=0;y<8;y++)for(let x=0;x<8;x++){
  const a=r.xMin+(r.offsetX+Math.floor((x+.5)*r.width/8)+.5)/r.canvasWidth*(r.xMax-r.xMin),b=r.yMin+(r.offsetY+Math.floor((y+.5)*r.height/8)+.5)/r.canvasHeight*(r.yMax-r.yMin);
  const q=(a-.25)*(a-.25)+b*b;if(q*(q+a-.25)<=.25*b*b||(a+1)*(a+1)+b*b<=.0625)continue;
  let re=0,im=0,k=0;while(re*re+im*im<=4&&k<r.iterations){const next=re*re-im*im+a;im=2*re*im+b;re=next;k++;}total+=k;
 }
 return total/64*r.width*r.height;
}
async function workload(kind,config={}){
 if(kind==='render'){
  const {referenceFractal}=require('@harmony/reference-capabilities'),tileSize=512,canvasWidth=2048,canvasHeight=1536,documents=[];
  const scene={xMin:-.748,xMax:-.744,yMin:.126,yMax:.130,...config.scene,iterations:config.iterations??4096};
  for(let y=0;y<canvasHeight;y+=tileSize)for(let x=0;x<canvasWidth;x+=tileSize){
   const region={width:tileSize,height:tileSize,canvasWidth,canvasHeight,offsetX:x,offsetY:y,...scene},bytes=Buffer.from(JSON.stringify(region)),expected=referenceFractal(region);
   documents.push({bytes,region,expectedHash:hash(expected),verify:async b=>assert.equal(hash(b),hash(expected),'RENDER_PIXEL_MISMATCH')});
  }
  return {capability:'render.fractal.v1',schema:'render.region',output:'render.rgb',parameters:{width:tileSize,height:tileSize,iterations:scene.iterations},bytes:documents[0].bytes,verify:documents[0].verify,documents,canvasWidth,canvasHeight,
   assemble:async outputs=>{const raw=Buffer.alloc(canvasWidth*canvasHeight*3);for(const [index,b] of outputs){const r=documents[index%documents.length].region;for(let y=0;y<r.height;y++)b.copy(raw,((r.offsetY+y)*canvasWidth+r.offsetX)*3,12+y*r.width*3,12+(y+1)*r.width*3);}return sharp(raw,{raw:{width:canvasWidth,height:canvasHeight,channels:3}}).png().toBuffer();}};
 }
 if(kind==='text'){
  const repetitions=160000,line='row abc def 123\n',text=line.repeat(repetitions),bytes=Buffer.from(JSON.stringify({text}));
  return {capability:'text.count.v1',schema:'text.input',output:'text.counts',parameters:{},bytes,verify:async b=>assert.deepEqual(JSON.parse(b),{characters:line.length*repetitions,words:4*repetitions,lines:repetitions+1})};
 }
 if(kind!=='crop')throw Error('WORKLOAD_INVALID');
 const bytes=await sharp({create:{width:4096,height:4096,channels:3,background:{r:255,g:0,b:0}}}).png().toBuffer();
 return {capability:'image.crop.v1',schema:'image.raster',output:'image.raster',parameters:{box:{x:0,y:0,width:1,height:1},paddingRatio:0,targetSize:1024,jpegQuality:95},bytes,verify:async b=>{
  const image=sharp(b),meta=await image.metadata();assert.equal(meta.width,1024);assert.equal(meta.height,1024);assert.equal(meta.format,'jpeg');
  const stats=await image.stats();assert.ok(stats.channels[0].min>=245&&stats.channels[1].max<=10&&stats.channels[2].max<=10,'PIXEL_MISMATCH');
 }};
}
async function main(){
 const [configFile,kind,out,countRaw='6',roundsRaw='1',concurrencyRaw='3']=process.argv.slice(2),count=Number(countRaw),rounds=Number(roundsRaw),concurrency=Number(concurrencyRaw);
 assert.ok([count,rounds,concurrency].every(n=>Number.isInteger(n)&&n>0));assert.ok(count<=100&&rounds<=7&&concurrency<=6);
 const config=JSON.parse(fs.readFileSync(configFile)),ca=fs.readFileSync(config.certificate),base=config.origin+'/v2/spaces/'+config.group,priority=config.priority??'REMOTE_BATCH';
 fs.mkdirSync(out,{recursive:true});assert.ok(!fs.existsSync(path.join(out,'RESULTS.json')),'REPORT_EXISTS');
 const context=new AsyncLocalStorage(),agent=new https.Agent({keepAlive:true,maxSockets:8});
 async function request(route,method='GET',body=null,binary=false){
  const start=performance.now(),row=context.getStore();
  try{return await new Promise((resolve,reject)=>{const bytes=body===null?null:Buffer.from(body),q=https.request(base+route,{ca,agent,method,headers:{Cookie:config.cookie,...(bytes?{'Content-Type':binary?'application/octet-stream':'application/json','Content-Length':bytes.length}:{})}},r=>{const chunks=[];r.on('data',b=>chunks.push(b));r.on('error',reject);r.on('end',()=>{const result=Buffer.concat(chunks);if(r.statusCode!==200){let code='HTTP_'+r.statusCode;try{code=JSON.parse(result).error??code;}catch{}reject(Error(code));}else resolve(result);});});q.on('error',reject);q.setTimeout(45000,()=>q.destroy(Error('HTTP_TIMEOUT')));q.end(bytes);});}
  finally{if(row)row.requests.push({phase:route==='/sdk/jobs'?'plan':route.endsWith('/input')?'upload':route.endsWith('/output')?'download':route.endsWith('/start')?'start':route.endsWith('/received')?'ack':'status',ms:performance.now()-start});}
 }
 const clockDomainId=randomUUID();let port={request:async(r,b)=>(await request(r.replace('/v2/sdk','/sdk'),b===null?'GET':'POST',b)).toString(),write:(t,b)=>request('/sdk/jobs/'+t.ref.artifactId.slice(3)+'/input','PUT',b,true),read:t=>request('/sdk/jobs/'+t.ref.artifactId.slice(4)+'/output'),digest:async b=>hash(b),now:Date.now,measure:()=>({clockDomainId,milliseconds:performance.now()}),wait:ms=>new Promise(r=>setTimeout(r,ms))};
 if(config.connection){const native=require('@harmony/scheduler-client/dist/node').nodeSdkPort(config.connection),timed=async(phase,fn)=>{const start=performance.now();try{return await fn();}finally{context.getStore()?.requests.push({phase,ms:performance.now()-start});}};port={...native,request:(r,b)=>timed(r==='/v2/sdk/jobs'?'plan':r.endsWith('/start')?'start':r.endsWith('/received')?'ack':'status',()=>native.request(r,b)),write:(t,b)=>timed('upload',()=>native.write(t,b)),read:t=>timed('download',()=>native.read(t))};}
 const sdk=new SchedulerSdk(port),w=await workload(kind,config),snapshot=JSON.parse(await request('')),devices=snapshot.devices.filter(d=>d.online&&(!config.deviceIds||config.deviceIds.includes(d.id)));assert.equal(devices.length,config.deviceIds?.length??3,'REQUESTED_DEVICES_REQUIRED');
 const targets=devices.map(d=>{const c=d.capabilities.find(c=>c.capability===w.capability&&c.available);assert.ok(c,'CAPABILITY_NOT_READY '+d.name);const cpuSlots=d.profile?.pools.find(p=>p.kind==='CPU_SLOTS')?.admissionLimit.value;assert.ok(Number.isInteger(cpuSlots)&&cpuSlots>0,'CPU_CAPACITY_UNKNOWN');return {name:d.name,deviceId:d.id,targetId:c.targetId,cpuSlots};});
 const report={version:1,startedAt:new Date().toISOString(),domain:snapshot.coordinator.domain,kind,count,rounds,concurrency,priority,submissionWindow:'min(caller limit, sum of declared CPU slots of eligible devices)',budgetMs:30000,inputSha256:hash(w.bytes),inputBytes:w.bytes.length,parameters:w.parameters,targets,batches:[],verdict:'RUNNING',boundary:'Input registration through verified results, including render image assembly and PNG write. Same SDK/coordinator, fixed caller concurrency ceiling, budget and task priority for every resource set. Independent reference generation, warmup and trace collection excluded. Batch throughput, not one indivisible task.'};
 assert.equal(report.domain,'REAL');if(w.documents){report.documents=w.documents.map(d=>({region:d.region,inputSha256:hash(d.bytes),expectedHash:d.expectedHash}));report.completeImage=count===w.documents.length;report.canvas={width:w.canvasWidth,height:w.canvasHeight};}const save=()=>fs.writeFileSync(path.join(out,'RESULTS.json'),JSON.stringify(report,null,2));save();
 async function run(mode,round,n){
  const batch={mode:mode.name,deviceCount:mode.targets.length,allowedDevices:mode.targets.map(t=>t.deviceId),round,concurrency:Math.min(concurrency,mode.targets.reduce((n,t)=>n+t.cpuSlots,0)),samples:[]};report.batches.push(batch);let next=0,failed=false;const outputs=new Map(),start=performance.now();
  const order=w.documents?.map((d,index)=>({index,estimatedWork:config.tileOrder==='estimated-cost'?estimatedRegionWork(d.region):0}));
  if(order&&config.tileOrder==='estimated-cost')order.sort((a,b)=>b.estimatedWork-a.estimatedWork||a.index-b.index);
  if(order){batch.tileOrder=config.tileOrder??'row-major';batch.order=order;batch.orderingMs=performance.now()-start;}
  await Promise.all(Array.from({length:Math.min(n,batch.concurrency)},async()=>{while(!failed&&next<n){const index=next++,jobId=randomUUID(),row={index,jobId,requests:[],state:'RUNNING'};batch.samples.push(row);const begin=performance.now();
   await context.run(row,async()=>{try{
    row.documentIndex=order?.[index%order.length].index??0;const document=w.documents?.[row.documentIndex]??w;row.inputSha256=hash(document.bytes);
    const input=await sdk.registerInput(document.bytes,w.schema),common={version:3,id:jobId,outputContract:w.output,qualityTarget:'reference'};
    const alternatives=mode.targets.map((t,i)=>({...common,id:jobId+'-'+i,nodes:[{id:'compute',capability:w.capability,input,parameters:JSON.stringify({...w.parameters,...(w.documents?{regionKey:hash(document.bytes)}:{})}),dependsOn:[],targetId:t.targetId}]}));
    const workflow=alternatives.length===1?alternatives[0]:{...common,alternatives};
    const task=await sdk.submit(workflow,{requestId:jobId,budgetMs:30000,resultDestination:'ORIGIN',priority});row.submittedMs=performance.now()-begin;
    const result=await task.result(45000);row.outputReadyMs=performance.now()-begin;Object.assign(row,{deviceId:result.status.deviceId,targetId:result.status.targetId,traceId:result.status.traceId,outputHash:hash(result.output),outputBytes:result.output.length});
    assert.equal(result.status.state,'SUCCEEDED');assert.ok(batch.allowedDevices.includes(row.deviceId));await document.verify(Buffer.from(result.output));if(w.assemble)outputs.set(row.documentIndex,Buffer.from(result.output));row.state='PASS';
   }catch(e){row.state='FAILED';row.error=e.message;failed=true;}finally{row.durationMs=performance.now()-begin;save();}});
  }}));
  if(w.assemble&&!failed&&round>=0){const image=await w.assemble(outputs),filename='round-'+round+'-set-'+batch.allowedDevices.map(d=>targets.findIndex(t=>t.deviceId===d)).join('')+'.png';fs.writeFileSync(path.join(out,filename),image);batch.image=filename;batch.imageHash=hash(image);}
  batch.durationMs=performance.now()-start;batch.actualDevices=[...new Set(batch.samples.map(s=>s.deviceId).filter(Boolean))];save();
  console.log(round+' | '+mode.name+' | '+batch.durationMs.toFixed(0)+' ms | '+batch.samples.filter(s=>s.state==='PASS').length+'/'+n);
  for(const row of batch.samples){if(!row.traceId)continue;try{let t;if(config.connection)t=await new Promise((resolve,reject)=>{const q=https.get(config.origin+'/v2/traces/'+row.traceId,{ca,agent,headers:{Authorization:'Bearer '+config.connection.credential}},r=>{const chunks=[];r.on('data',b=>chunks.push(b));r.on('error',reject);r.on('end',()=>{try{if(r.statusCode!==200)throw Error('TRACE_HTTP_'+r.statusCode);resolve(JSON.parse(Buffer.concat(chunks)));}catch(e){reject(e);}});});q.on('error',reject);q.setTimeout(15000,()=>q.destroy(Error('TRACE_TIMEOUT')));});else t=JSON.parse(await request('/jobs/'+row.jobId+'/trace'));fs.writeFileSync(path.join(out,row.jobId+'-trace.json'),JSON.stringify(t));}catch(e){row.traceError=e.message;}}
  if(failed){report.verdict='FAILED';save();throw Error('BATCH_FAILED');}
 }
 try{
  for(const t of targets)await run({name:'WARMUP '+t.name,targets:[t]},-1,1);
  const all=modes(targets);for(let round=0;round<rounds;round++){const offset=(round*(all.length===7?3:1))%all.length,order=all.slice(offset).concat(all.slice(0,offset));for(const mode of order)await run(mode,round,count);}
  const median=a=>{a.sort((x,y)=>x-y);return a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;};
  report.summary=all.map(m=>({mode:m.name,deviceCount:m.targets.length,medianMs:median(report.batches.filter(b=>b.round>=0&&b.mode===m.name).map(b=>b.durationMs))}));
  const fastest=n=>Math.min(...report.summary.filter(s=>s.deviceCount===n).map(s=>s.medianMs));report.speedupVsBestSingle=targets.length===3?fastest(1)/fastest(3):null;report.speedupVsBestPair=targets.length===3?fastest(2)/fastest(3):null;
  report.allThreeUsedEveryRound=report.batches.filter(b=>b.round>=0&&b.deviceCount===3).every(b=>b.actualDevices.length===3);
  report.verdict=targets.length!==3?'INSUFFICIENT_DEVICE_COUNT':!report.allThreeUsedEveryRound?'THREE_DEVICE_PARTICIPATION_MISSING':report.speedupVsBestSingle>1&&report.speedupVsBestPair>1?'MEASURED_SPEEDUP':'NO_SPEEDUP';report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({verdict:report.verdict,summary:report.summary}));
 }finally{agent.destroy();}
}
module.exports={modes,workload,estimatedRegionWork};if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
