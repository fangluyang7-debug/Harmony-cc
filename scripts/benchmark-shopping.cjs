// Replays one real shopping candidate set. No cloud re-query or duplicated candidates.
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),{randomUUID,createHash}=require('node:crypto'),{performance}=require('node:perf_hooks');
const hash=b=>createHash('sha256').update(b).digest('hex');
const median=values=>{const a=[...values].sort((x,y)=>x-y);return a.length%2?a[a.length>>1]:(a[a.length/2-1]+a[a.length/2])/2;};
function reference(part){const items=part.items.filter(p=>p.currency==='CNY'&&Number(p.price)<=part.maxPriceMinor/100).map(p=>({id:p.id,priceMinor:Math.round(Number(p.price)*100),rank:p.rank})).sort((a,b)=>a.priceMinor-b.priceMinor||a.rank-b.rank||a.id.localeCompare(b.id));return {scanned:part.items.length,excluded:part.items.length-items.length,items};}
async function compareShopping({source,targets,sdkFactory,rounds=5,packed=false,save=()=>{},ready=async()=>{}}){
 if(targets.length!==2||new Set(targets.map(t=>t.targetId)).size!==2||!Number.isInteger(rounds)||rounds<1||rounds>10)throw Error('BENCHMARK_OPTIONS');
 const {partitionCandidates,mergePartitions}=await import('../apps/team-space-web/shopping-runtime.mjs');
 const modes=packed?[{name:'WINDOWS_PACKED',target:0,count:1},{name:'PHONE_PACKED',target:1,count:1},{name:'AUTO_PACKED',count:1},{name:'TEAM',count:2}]:[{name:'WINDOWS',target:0,count:2},{name:'PHONE',target:1,count:2},{name:'TEAM',count:2}];
 const report={version:1,startedAt:new Date().toISOString(),sourceRunId:source.sourceRunId,query:source.query,sourceHash:hash(Buffer.from(JSON.stringify(source.candidates))),candidateCount:source.candidates.length,maxPriceMinor:source.maxPriceMinor,budgetMsPerJob:30000,rounds,packed,boundary:'input registration through all verified results and merge; excludes cloud retrieval and post-run evidence queries',singleDeviceBoundary:'single execution target through the same coordinator and SDK, not standalone offline app execution',targets,batches:[],state:'RUNNING'};
 save(report);
 for(let round=-1;round<rounds;round++){
  const offset=round<0?0:round%modes.length,order=modes.slice(offset).concat(modes.slice(0,offset));
  for(const mode of order){
   const readyStart=performance.now();try{await ready();}catch(e){report.state='ABORTED';report.error=e.message;save(report);return report;}const readinessWaitMs=performance.now()-readyStart;
   const parts=partitionCandidates(source.candidates,mode.count,source.maxPriceMinor),batch={round,warmup:round<0,mode:mode.name,readinessWaitMs,samples:[],requests:[]};report.batches.push(batch);
   const sdk=sdkFactory(batch),start=performance.now();
   const tasks=await Promise.allSettled(parts.map(async(part,index)=>{
    const id=randomUUID(),bytes=Buffer.from(JSON.stringify(part)),expected=reference(part),target=mode.name==='TEAM'?targets[index]:mode.target!==undefined?targets[mode.target]:null;
    const sample={index,jobId:id,inputCount:part.items.length,inputHash:hash(bytes),expectedHash:hash(Buffer.from(JSON.stringify(expected))),state:'STARTING',requestedTarget:target?.targetId};batch.samples.push(sample);
    const clock=performance.now(),input=await sdk.registerInput(bytes,'catalog.items');
    try{const task=await sdk.submit({version:3,id,outputContract:'catalog.ranked',qualityTarget:'reference',nodes:[{id:'catalog',capability:'catalog.filter.v1',input,parameters:JSON.stringify({sourceRunId:source.sourceRunId,partition:index,partitions:parts.length}),dependsOn:[],...(target?{targetId:target.targetId}:{})}]},{requestId:id,budgetMs:30000,resultDestination:'ORIGIN'});
     const result=await task.result();sample.durationMs=performance.now()-clock;sample.outputHash=hash(result.output);sample.deviceId=result.status.deviceId;sample.targetId=result.status.targetId;sample.traceId=result.status.traceId;
     if(result.status.state!=='SUCCEEDED'||sample.outputHash!==sample.expectedHash)throw Error('RESULT_MISMATCH');if(target&&sample.targetId!==target.targetId)throw Error('TARGET_MISMATCH');sample.state='PASS';return JSON.parse(Buffer.from(result.output));
    }catch(e){sample.state='FAILED';sample.error=e.message;throw e;}finally{sdk.releaseInput(input);}
   }));
   if(tasks.every(t=>t.status==='fulfilled')){const merged=mergePartitions(source.candidates,tasks.map(t=>t.value),source.maxPriceMinor);batch.resultHash=hash(Buffer.from(JSON.stringify(merged)));batch.matched=merged.items.length;}
   batch.durationMs=performance.now()-start;batch.samples.sort((a,b)=>a.index-b.index);save(report);
   if(tasks.some(t=>t.status==='rejected')){report.state='FAILED';save(report);return report;}
  }
 }
 report.medians=Object.fromEntries(modes.map(m=>[m.name,median(report.batches.filter(b=>!b.warmup&&b.mode===m.name).map(b=>b.durationMs))]));
 const singles=modes.filter(m=>m.target!==undefined).map(m=>m.name);report.fastestSingle=singles.reduce((a,b)=>report.medians[a]<=report.medians[b]?a:b);report.speedup=report.medians[report.fastestSingle]/report.medians.TEAM;
 report.teamAllBatchesUseTwo=report.batches.filter(b=>b.mode==='TEAM').every(b=>new Set(b.samples.map(s=>s.deviceId)).size===2);report.state=report.teamAllBatchesUseTwo&&report.speedup>1?'MEASURED_SPEEDUP':'NO_SPEEDUP';save(report);return report;
}
async function main(){
 const [configFile,sourceFile,out,kind]=process.argv.slice(2);if(!configFile||!sourceFile||!out)throw Error('ARGUMENTS');
 const config=JSON.parse(fs.readFileSync(configFile)),source=JSON.parse(fs.readFileSync(sourceFile)),ca=fs.readFileSync(config.caFile),agent=new https.Agent({keepAlive:true,ca}),{SchedulerSdk}=require('@harmony/scheduler-client'),{spacePort}=await import('../apps/team-space-web/shopping-runtime.mjs');
 const request=(route,options={},measure)=>new Promise((resolve,reject)=>{const start=performance.now(),r=https.request(new URL(route,config.address),{agent,method:options.method||'GET',headers:{...options.headers,Cookie:config.cookie}},s=>{const b=[];s.on('data',x=>b.push(x));s.on('end',()=>{measure?.({route,method:options.method||'GET',durationMs:performance.now()-start,status:s.statusCode});resolve(new Response(Buffer.concat(b),{status:s.statusCode,headers:s.headers}));});});r.on('error',reject);r.end(options.body==null?undefined:Buffer.from(options.body));});
 const snapshot=await(await request('/v2/spaces/'+config.group)).json(),targets=config.devices.map(id=>{const d=snapshot.devices.find(d=>d.id===id),c=d?.capabilities.find(c=>c.capability==='catalog.filter.v1');if(!d||!c)throw Error('DEVICE_NOT_READY');return {deviceId:id,targetId:c.targetId,name:d.name};});
 const ready=async()=>{for(const until=Date.now()+180000;Date.now()<until;){const s=await(await request('/v2/spaces/'+config.group)).json();if(targets.every(target=>s.devices.some(d=>d.id===target.deviceId&&d.online&&d.capabilities.every(c=>['ACTIVE','CANARY'].includes(c.state))&&d.capabilities.some(c=>c.targetId===target.targetId&&c.available))))return;await new Promise(resolve=>setTimeout(resolve,1000));}throw Error('DEVICE_NOT_READY');};
 fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});fs.writeFileSync(out,'{}',{flag:'wx'});
 try{const report=await compareShopping({source,targets,ready,packed:kind==='packed',rounds:Number(process.env.SHOPPING_BENCH_ROUNDS||5),sdkFactory:batch=>new SchedulerSdk(spacePort(config.group,(route,opts)=>request(route,opts,r=>batch.requests.push(r)),async b=>hash(b))),save:r=>{fs.writeFileSync(out,JSON.stringify(r,null,2));const b=r.batches.at(-1);if(b?.durationMs)console.log(JSON.stringify({round:b.round,mode:b.mode,ms:Math.round(b.durationMs),pass:b.samples.every(s=>s.state==='PASS')}));}});console.log(JSON.stringify({state:report.state,medians:report.medians,speedup:report.speedup}));if(report.state==='FAILED')process.exitCode=1;}finally{agent.destroy();}
}
module.exports={compareShopping,reference,median};if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
