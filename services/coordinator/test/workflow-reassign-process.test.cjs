const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {runtime}=require('./helpers.cjs'),{builtinCpuPacks}=require('@harmony/reference-capabilities'),{collect,final,counts}=require('./workflow-packs.cjs'),{child,until}=require('./workflow-process-util.cjs');
test('formal unpinned graph reassigns C to D after C receives B output; C serves the copy after B endpoint changes',async()=>{
 const r=await runtime({cpuHost:true,referencePacks:[...builtinCpuPacks(),collect,final]}),hosts=[child(),child(),child()],peers=[],pids=[];
 try{
  const group=randomUUID(),capacity=[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:268435456}];
  for(let i=0;i<3;i++){
   const device=randomUUID(),holder=randomUUID(),invite=await r.auth.invite(group,randomUUID(),device,r.url),owner=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:holder});let paired=owner;
   await r.allotments.confirmDevice(device,capacity,[{groupId:group,holderInstanceId:holder,appInstanceId:null}]);
   if(i===0){const registration=await r.apps.register(owner.peer,{label:'Reassignment source',allowedContracts:['text.count.v1',collect.manifest.contract.contractId,final.manifest.contract.contractId],maxConcurrent:4,resources:capacity,offlineBase:capacity,onlineExtra:[]},r.url);paired=await r.apps.exchange({registrationId:registration.registrationId,code:registration.code});}
   peers.push(paired.peer);const identity={groupId:group,deviceId:device,holderInstanceId:paired.peer.holderInstanceId,appInstanceId:paired.peer.app?.appInstanceId??null};
   pids.push((await hosts[i].request({action:'open',certificate:invite.certificate,source:i===0,config:{directory:path.join(r.config.dataDir,identity.holderInstanceId),identity,connection:{address:r.url,certificate:invite.certificate,fingerprint:invite.fingerprint,credential:paired.credential,domain:'SIMULATED'},controlIntervalMs:1500,contribution:{ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0}}})).pid);
  }
  assert.equal(new Set([...pids,process.pid]).size,4);
  await until(async()=>{try{const c=(await r.snapshots.build(group)).snapshot.candidates;return c.some(x=>x.capability===final.manifest.contract.capability)&&peers.every(peer=>c.some(x=>x.capability==='text.count.v1'&&x.holderInstanceId===peer.holderInstanceId));}catch{return false;}});
  for(const h of hosts)await h.request({action:'freeze'});
  async function links(){const endpoints=await r.directTransfers.list(peers[0]);for(let i=0;i<3;i++){const network=await r.directTransfers.resetNetwork(peers[i]);for(let j=0;j<3;j++)if(i!==j){const e=endpoints.find(e=>e.holderInstanceId===peers[j].holderInstanceId),fixed=i===0&&j===2?50:.01;await r.directTransfers.reportLink(peers[i],{epoch:network.epoch,endpointId:e.id,endpointEpoch:e.epoch,direction:'WRITE',reason:'REACHABLE',samples:[1024,8192,32768].map(bytes=>({bytes,durationMs:fixed+bytes/1000000}))});}}await r.profiles.refresh(group);}
  for(let i=0;i<3;i++)await hosts[i].request({action:'cost',value:[10000,1,10][i]});
  await until(async()=>{await r.profiles.refresh(group);const c=(await r.snapshots.build(group)).snapshot.candidates;return peers.every((peer,i)=>c.some(x=>x.capability==='text.count.v1'&&x.holderInstanceId===peer.holderInstanceId&&x.computeMs===[10000,1,10][i]));});await links();
  const id=randomUUID(),start=r.jobs.start.bind(r.jobs);let reassigned=false,parentRef;
  r.jobs.start=async(peer,jobId,...rest)=>{
   const row=await r.db.cpuJob.findUnique({where:{id:jobId}}),d=row&&JSON.parse(row.metadataJson);
   if(d?.offer.task.workflowId===id&&d.offer.task.nodeId==='count'&&!reassigned&&await r.directTransfers.hasInput(group,peers[1].holderInstanceId,peers[0].app.appInstanceId,d.input.ref)){
    reassigned=true;parentRef=d.input.ref;await hosts[1].request({action:'pause'});
    await until(async()=>{await r.profiles.refresh(group);return !(await r.snapshots.build(group)).snapshot.candidates.some(c=>c.holderInstanceId===peers[1].holderInstanceId);});
    await hosts[0].request({action:'register-endpoint'});await links();
   }
   return start(peer,jobId,...rest);
  };
  await hosts[0].request({action:'submit',jobId:id});const result=await hosts[0].request({action:'result',jobId:id});assert.equal(result.state,'SUCCEEDED');assert.deepEqual(Buffer.from(result.output,'base64'),counts);assert.equal(reassigned,true);
  const attempts=await r.db.attempt.findMany({where:{workflowId:id}});assert.equal(attempts.length,3);assert.equal(attempts.find(a=>JSON.parse(a.taskJson).nodeId==='count').holderInstanceId,peers[2].holderInstanceId);assert.equal(attempts.some(a=>a.holderInstanceId===peers[1].holderInstanceId),false);
  const grants=await r.db.transferAuthorization.findMany({where:{groupId:group,state:'COMPLETED'}});assert.ok(grants.map(g=>JSON.parse(g.metadataJson).authorization).some(a=>a.senderHolderId===peers[1].holderInstanceId&&a.receiverHolderId===peers[2].holderInstanceId&&a.ref.artifactId===parentRef.artifactId));
  await until(async()=>!await hosts[0].request({action:'ref',groupId:group,ref:parentRef}));console.log('REASSIGNMENT_GRAPH '+JSON.stringify({pids,state:result.state,attempts:attempts.length,from:'C',to:'D',sourceEndpointChanged:true}));
 }finally{for(const h of hosts){try{await h.request({action:'close'});}catch{}h.close();}await r.close();}
});
