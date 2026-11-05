const {CpuHost}=require('../../pc-agent/dist/host'),{DurableLedger}=require('../../pc-agent/dist/durable-ledger');
const {collect,final,raw}=require('./workflow-packs.cjs');let host,mode='',faults=0;const tasks=new Map();
process.on('message',async m=>{try{let value;
 if(m.action==='open'){
  const {config,certificate,source}=m;
  const ledger=await DurableLedger.open(config.directory,config.identity,certificate);await ledger.close();
  host=await CpuHost.open({...config,...(source?{fixedServices:[collect,final].map(pack=>({pack,execute:async input=>({bytes:input,schemaId:pack.manifest.contract.outputSchemas[0]})}))}:{})},()=>{});host.start();value={pid:process.pid};
 }else if(m.action==='cost'){
  if(host.config.connection.domain!=='SIMULATED')throw Error('FIXTURE_DOMAIN');
  // Freeze only the synthetic selection prior; automatic calibration must not
  // race this deterministic topology fixture. Engine timings remain measured.
  if(!host.fixtureCosts){host.fixtureCosts=new Map();const executor=host.executor.bind(host);host.executor=(capability,now)=>{const result=executor(capability,now),fixed=host.fixtureCosts.get(capability);if(fixed!==undefined){result.compute={...result.compute,value:fixed,source:'PRIOR',sampledAt:now};result.cold={...result.cold,value:0,source:'PRIOR',sampledAt:now};}return result;};}
  host.fixtureCosts.set('text.count.v1',m.value);await host.tick();value=true;
 }else if(m.action==='pause'){host.config.contribution.ownerMode='paused';await host.tick();value=true;
 }else if(m.action==='evict-ref'){
  const cache=host.dataHost.channel,d=cache.lookup(m.groupId,m.ref);value=!!d&&cache.forget(d);
 }else if(m.action==='register-endpoint'){await host.dataHost.register();value=host.dataHost.identity();
 }else if(m.action==='freeze'){
  host.peerLinks.close();await host.networkPending;value=true;
 }else if(m.action==='fault'){
  mode=m.mode;faults=0;host.dataHost.channel.limits.cacheBytes=mode==='cache-full'?0:134217728;
  if(!host.faultInstalled){const server=host.dataHost.server,handlers=server.listeners('request');server.removeAllListeners('request');server.on('request',(req,res)=>{
   const business=req.method==='PUT'&&req.url.startsWith('/v2/direct/')&&!req.url.startsWith('/v2/direct/probe');
   if(business&&mode==='cache-full')faults++;
   if(business&&mode==='isolate'){faults++;req.destroy();return;}
   if(business&&mode==='drop-reply'){faults++;mode='';res.end=function(){res.destroy();return res;};}
   for(const handler of handlers)handler.call(server,req,res);
  });host.faultInstalled=true;}value=true;
 }else if(m.action==='submit'){
  const sdk=host.sdk(),input=await sdk.registerInput(raw,'text.input'),workflow={version:3,id:m.jobId,outputContract:'text.counts',qualityTarget:'reference',nodes:[{id:'collect',capability:collect.manifest.contract.capability,input,parameters:'{}',dependsOn:[]},{id:'count',capability:'text.count.v1',inputFrom:'collect',parameters:'{}',dependsOn:['collect'],...(m.targetId?{targetId:m.targetId}:{})},{id:'finish',capability:final.manifest.contract.capability,inputFrom:'count',parameters:'{}',dependsOn:['count']}]};
  const task=await sdk.submit(workflow,{requestId:m.jobId,budgetMs:30000,resultDestination:'ORIGIN',inputLocation:'ORIGIN'});tasks.set(m.jobId,task);value=true;
 }else if(m.action==='result'){const result=await tasks.get(m.jobId).result();value={state:result.status.state,output:Buffer.from(result.output).toString('base64'),faults};
 }else if(m.action==='ref'){const channel=host.dataHost.channel,descriptor=channel.lookup(m.groupId,m.ref);value=!!descriptor&&channel.available(descriptor);
 }else if(m.action==='close'){await host.close();value=true;}else throw Error('CHILD_ACTION_INVALID');
 process.send({id:m.id,value});
 }catch(e){process.send({id:m.id,error:e.message});}});
