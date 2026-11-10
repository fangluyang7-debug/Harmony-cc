// Application/tool orchestration only. Target selection and dispatch remain in
// SchedulerSdk -> PlanningService. All task inputs are uploaded after the timer.
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),sharp=require('sharp');
const {createHash,randomUUID}=require('node:crypto'),{performance}=require('node:perf_hooks');
const {SchedulerSdk}=require('@harmony/scheduler-client'),{nodeSdkPort,appRequest}=require('@harmony/scheduler-client/dist/node');
const {encodeGraph,partitionPairs,mergeGraph}=require('./lib/visual-input.cjs');
const capability='image.visual-match.v1',hash=b=>createHash('sha256').update(b).digest('hex');
async function loadImages(manifest,directory){
 const images=[];for(const row of manifest.images){const original=await fs.promises.readFile(path.resolve(directory,row.file));if(hash(original)!==row.sha256)throw Error('SOURCE_IMAGE_CHANGED');
  const {data,info}=await sharp(original).rotate().resize(512,512,{fit:'inside',withoutEnlargement:true}).removeAlpha().toColourspace('srgb').raw().toBuffer({resolveWithObject:true});
  images.push({id:row.id,width:info.width,height:info.height,rgb:data,originalHash:row.sha256});}
 if(images.length<2||images.length>32||new Set(images.map(i=>i.originalHash)).size!==images.length)throw Error('DISTINCT_REAL_IMAGES_REQUIRED');return images;
}
async function runVisual({manifest,directory,connection,mode,targets,pairBatchSize=64,save=()=>{},overallBudgetMs=120000}){
 if(!['WINDOWS','PHONE','TEAM'].includes(mode)||targets.length!==2)throw Error('VISUAL_RUN_OPTIONS');
 const run={id:randomUUID(),mode,startedAt:new Date().toISOString(),state:'PREPARING',budgetMsPerTask:30000,overallBudgetMs,pairBatchSize,sourceRunId:manifest.sourceRunId,query:manifest.query,jobs:[],transfers:[],requests:[]};const start=performance.now();save(run);
 const images=await loadImages(manifest,directory);run.sourceBytes=manifest.images.reduce((s,i)=>s+i.bytes,0);run.sourceHash=hash(Buffer.from(JSON.stringify(manifest.images.map(i=>({id:i.id,hash:i.sha256})))));run.normalizedHash=hash(Buffer.concat(images.flatMap(i=>[Buffer.from(i.id+':'+i.width+':'+i.height+':'),i.rgb])));
 const batches=partitionPairs(images,pairBatchSize),inputs=batches.map(pairs=>encodeGraph(images,pairs));run.preparationMs=performance.now()-start;run.pairCount=images.length*(images.length-1)/2;run.imageCount=images.length;run.state='RUNNING';
 const base=nodeSdkPort(connection),port={...base,request:async(route,body)=>{const t=performance.now();try{return await base.request(route,body);}finally{run.requests.push({route,method:body===null?'GET':'POST',ms:performance.now()-t});}},write:async(ticket,bytes)=>{const t=performance.now();await base.write(ticket,bytes);run.transfers.push({kind:'INPUT_UPLOAD',artifactId:ticket.ref.artifactId,contentHash:hash(bytes),bytes:bytes.byteLength,ms:performance.now()-t,afterStartMs:performance.now()-start});},writeDirect:async(jobId,endpointId,ticket,bytes)=>{const t=performance.now();await base.writeDirect(jobId,endpointId,ticket,bytes);run.transfers.push({kind:'INPUT_UPLOAD',artifactId:ticket.ref.artifactId,contentHash:hash(bytes),bytes:bytes.byteLength,ms:performance.now()-t,afterStartMs:performance.now()-start,direct:true});}};
 const sdk=new SchedulerSdk(port),target=mode==='WINDOWS'?targets[0]:mode==='PHONE'?targets[1]:null;
 // Single-device runs can use every configured slot, not just one worker.
 const concurrency=Math.min(batches.length,mode==='TEAM'?targets.reduce((s,t)=>s+t.cpuSlots,0):target.cpuSlots);run.concurrency=concurrency;
 let cursor=0,failed=false;const results=[],active=new Map();
 const worker=async()=>{while(!failed&&cursor<batches.length){const index=cursor++,job={index,id:randomUUID(),inputHash:hash(inputs[index]),inputBytes:inputs[index].length,pairs:batches[index].length,state:'STARTING'};run.jobs.push(job);save(run);let input;
  try{if(performance.now()-start>=overallBudgetMs)throw Error('WORKFLOW_BUDGET_EXHAUSTED');input=await sdk.registerInput(inputs[index],'image.visual-bundle');const t=performance.now();
   const task=await sdk.submit({version:3,id:job.id,outputContract:'image.visual-evidence',qualityTarget:'reference',nodes:[{id:'visual-verification',capability,input,parameters:'{}',dependsOn:[],...(target?{targetId:target.targetId}:{})}]},{requestId:job.id,budgetMs:30000,resultDestination:'ORIGIN'});active.set(job.id,task);
   const result=await task.result(Math.max(1,Math.min(45000,overallBudgetMs-(performance.now()-start))));Object.assign(job,{durationMs:performance.now()-t,state:result.status.state,deviceId:result.status.deviceId,targetId:result.status.targetId,traceId:result.status.traceId,outputHash:hash(result.output)});
   if(result.status.state!=='SUCCEEDED'||target&&result.status.targetId!==target.targetId||!targets.some(t=>t.deviceId===result.status.deviceId))throw Error('VISUAL_TARGET_OR_RESULT_INVALID');results[index]=JSON.parse(Buffer.from(result.output));
  }catch(e){failed=true;job.state='FAILED';job.error=e.message;if(active.has(job.id))await active.get(job.id).cancel().catch(()=>{});}finally{if(input)sdk.releaseInput(input);active.delete(job.id);save(run);}
 }};
 await Promise.all(Array.from({length:concurrency},worker));
 if(failed){run.state='FAILED';for(const task of active.values())await task.cancel().catch(()=>{});}else{run.pairs=mergeGraph(images.map(i=>i.id),results);run.resultHash=hash(Buffer.from(JSON.stringify(run.pairs)));run.state='SUCCEEDED';}
 run.durationMs=performance.now()-start;run.uploadedBytes=run.transfers.reduce((s,t)=>s+t.bytes,0);run.expectedUploadBytes=inputs.reduce((s,b)=>s+b.length,0);run.actualDevices=[...new Set(run.jobs.map(j=>j.deviceId).filter(Boolean))];
 if(run.state==='SUCCEEDED'&&(run.uploadedBytes!==run.expectedUploadBytes||run.durationMs>overallBudgetMs)){run.state='FAILED';run.error='INPUT_TRANSFER_OR_WORKFLOW_BUDGET';}save(run);return run;
}
function spaceRequest(config){return ()=>new Promise((resolve,reject)=>{const req=https.get(config.address+'/v2/spaces/'+config.group,{ca:fs.readFileSync(config.caFile),headers:{Cookie:config.cookie}},r=>{const chunks=[];r.on('error',reject);r.on('aborted',()=>reject(Error('SPACE_RESPONSE_ABORTED')));r.on('data',b=>chunks.push(b));r.on('end',()=>{if(r.statusCode!==200)return reject(Error('SPACE_HTTP_'+r.statusCode));try{resolve(JSON.parse(Buffer.concat(chunks)));}catch(e){reject(e);}});}).on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('SPACE_REQUEST_TIMEOUT')));});}
function deviceConditions(state,ids){return ids.map(id=>{const d=state.devices.find(d=>d.id===id);return {deviceId:id,online:d?.online??false,temperature:d?.profile?.temperature??null,energyGate:d?.profile?.energyGate??null,available:d?.capabilities.some(c=>c.capability===capability&&c.available)??false,calibrated:d?.capabilities.every(c=>['ACTIVE','CANARY'].includes(c.state))??false};});}
async function preflight(snapshot,ids,maximumThermalLevel=2){
 if(!Number.isInteger(maximumThermalLevel)||maximumThermalLevel<0||maximumThermalLevel>3)throw Error('START_THERMAL_LEVEL_INVALID');
 const started=Date.now();let stableSince=0,conditions=[];
 // Equal idle period for all modes. No task data is read or transferred here.
 await new Promise(r=>setTimeout(r,30000));
 while(Date.now()-started<300000){conditions=deviceConditions(await snapshot(),ids);const ready=conditions.every(d=>d.online&&d.available&&d.calibrated&&!d.energyGate&&(d.temperature?.value==null||d.temperature.value<=maximumThermalLevel));
  if(ready){if(!stableSince)stableSince=Date.now();if(Date.now()-stableSince>=5000)return {waitMs:Date.now()-started,minimumIdleMs:30000,maximumThermalLevel,conditions};}else stableSince=0;
  await new Promise(r=>setTimeout(r,2000));
 }throw Error('DEVICE_COOLDOWN_OR_READINESS_TIMEOUT');
}
async function main(){
 const [configFile,manifestFile,out,batch='64',roundsText='3',only]=process.argv.slice(2);if(!configFile||!manifestFile||!out)throw Error('ARGUMENTS');const config=JSON.parse(fs.readFileSync(configFile)),manifest=JSON.parse(fs.readFileSync(manifestFile)),snapshot=spaceRequest(config);let state;
 const rounds=Number(roundsText);if(!Number.isInteger(rounds)||rounds<1||rounds>5)throw Error('ROUNDS');
 let qualified=false;
 for(const deadline=Date.now()+240000;Date.now()<deadline;){state=await snapshot();qualified=config.devices.every(id=>state.devices.some(d=>d.id===id&&d.online&&d.capabilities.some(c=>c.capability===capability&&c.available)&&d.capabilities.every(c=>['ACTIVE','CANARY'].includes(c.state))));if(qualified)break;await new Promise(r=>setTimeout(r,1000));}
 if(!qualified)throw Error('DEVICE_CALIBRATION_NOT_READY');
 const targets=config.devices.map(id=>{const d=state.devices.find(d=>d.id===id),c=d?.capabilities.find(c=>c.capability===capability&&c.available);if(!d?.online||!c)throw Error('DEVICE_NOT_READY');return {deviceId:id,targetId:c.targetId,name:d.name,cpuSlots:d.settings.maxCpuThreads};});
 let connection;if(fs.existsSync(config.appConnectionFile)){connection=JSON.parse(fs.readFileSync(config.appConnectionFile));await appRequest(connection)('/v2/apps/me',null);}else{const owner=JSON.parse(fs.readFileSync(config.ownerConfig)).connection,request=appRequest(owner),slots=targets.reduce((s,t)=>s+t.cpuSlots,0),invitation=JSON.parse(await request('/v2/apps/registrations',JSON.stringify({label:'购物视觉复核 Agent',allowedContracts:[capability],maxConcurrent:slots,resources:[{resourcePoolId:'cpu',amount:slots},{resourcePoolId:'ram',amount:slots*134217728}],offlineBase:[],onlineExtra:[]})));fs.writeFileSync(config.appConnectionFile+'.pending',JSON.stringify(invitation));const app=JSON.parse(await request('/v2/apps/exchange',JSON.stringify({registrationId:invitation.registrationId,code:invitation.code})));connection={...owner,credential:app.credential};fs.writeFileSync(config.appConnectionFile,JSON.stringify(connection));}
 const modes=only?only.split(','):['WINDOWS','PHONE','TEAM'];if(modes.some(m=>!['WINDOWS','PHONE','TEAM'].includes(m))||new Set(modes).size!==modes.length)throw Error('MODES');
 const report={startedAt:new Date().toISOString(),noRealDataWarmup:true,targets,rounds,pairBatchSize:Number(batch),boundary:'source original file read + decode/normalize/compress + SDK submission/input upload + remote feature extraction/matching + output verification/merge',runs:[],state:'RUNNING'};
 fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});fs.writeFileSync(out,'{}',{flag:'wx'});const save=()=>fs.writeFileSync(out,JSON.stringify(report,null,2));save();
 for(let round=0;round<rounds;round++){const order=modes.slice(round%modes.length).concat(modes.slice(0,round%modes.length));for(const mode of order){let run,before;
  try{before=await preflight(snapshot,config.devices,config.maximumStartThermalLevel??2);}catch(e){report.state='FAILED';report.preflightFailure={round,mode,error:e.message};save();throw e;}
  await runVisual({manifest,directory:path.dirname(path.resolve(manifestFile)),connection,mode,targets,pairBatchSize:Number(batch),save:value=>{if(!run){run=value;report.runs.push(run);}run.round=round;run.preflight=before;save();}});
  run.after=deviceConditions(await snapshot(),config.devices);save();console.log(JSON.stringify({round,mode,state:run.state,ms:Math.round(run.durationMs),devices:run.actualDevices?.length,uploads:run.uploadedBytes,jobs:run.jobs.map(j=>({state:j.state,error:j.error}))}));if(run.state!=='SUCCEEDED'){report.state='FAILED';save();process.exitCode=1;return;}}}
 if(new Set(report.runs.map(r=>r.normalizedHash)).size!==1||new Set(report.runs.map(r=>r.resultHash)).size!==1){report.state='FAILED';report.error='CROSS_RUN_RESULT_MISMATCH';save();throw Error(report.error);}report.state='COMPLETE';save();
}
module.exports={runVisual,loadImages,spaceRequest};if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
