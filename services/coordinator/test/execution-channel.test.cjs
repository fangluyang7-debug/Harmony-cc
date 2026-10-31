const {test}=require('node:test'),assert=require('node:assert/strict');
const {once}=require('node:events'),fs=require('node:fs'),path=require('node:path');
const {WebSocket}=require('ws');
const {runtime}=require('./helpers.cjs'),{attempt}=require('./fixtures.cjs');
const {pinnedOptions,pinnedRequest}=require('../dist/pinned-client');
const {DurableLedger}=require('../../pc-agent/dist/durable-ledger');
test('rejected admission persists reason and trace and reports revoked credentials consistently',async()=>{
 const r=await runtime({cpuHost:true});let ws;
 try{
  const invite=await r.auth.invite('g1','p1','device1',r.url),paired=await pinnedRequest(invite,'/v2/pair',{inviteId:invite.inviteId,code:invite.code,holderInstanceId:'h1'});
  const f=attempt();f.message.senderInstanceId=r.identity.id;await r.store.persistOffer(f.offer,'h1',f.message);
  ws=new WebSocket(r.url.replace('https:','wss:')+'/v2/channel',{...pinnedOptions(invite),headers:{Authorization:'Bearer '+paired.credential}});
  const received=[];ws.on('message',b=>received.push(JSON.parse(b)));await once(ws,'open');
  const send=(seq,type,payload)=>ws.send(JSON.stringify({protocolVersion:2,messageId:'reject-'+seq,type,groupId:'g1',senderInstanceId:'h1',coordinatorEpoch:1,seq,ackOf:null,traceId:'rejection-trace',payload:JSON.stringify(payload),extensions:[]}));
  send(1,'Hello',{versions:[2],extensions:[]});
  send(2,'AdmissionReply',{attemptId:f.offer.task.attemptId,holderInstanceId:'h1',status:'REJECTED',reasonCode:'RESOURCE_LIMIT',record:null,wait:{value:null,source:'UNKNOWN',sampledAt:0,ttlMs:1000,unit:'ms'}});
  const deadline=Date.now()+5000;while(!received.some(m=>m.ackOf==='reject-2')){assert.ok(Date.now()<deadline,'rejection acknowledgement');await new Promise(r=>setTimeout(r,10));}
  const row=await r.db.attempt.findUnique({where:{id:f.offer.task.attemptId}}),rejection=JSON.parse(row.rejectionJson);
  assert.equal(row.state,'REJECTED');assert.equal(rejection.reply.reasonCode,'RESOURCE_LIMIT');assert.equal(rejection.traceId,'rejection-trace');assert.equal(row.recordJson,null);
  await r.auth.revoke(paired.credentialId??(await r.auth.authenticate(paired.credential)).credentialId);
  for(const route of ['/v2/devices','/v2/jobs/'+f.offer.task.attemptId]){
   await assert.rejects(pinnedRequest(invite,route,undefined,paired.credential),/401/);
  }
 }finally{ws?.terminate();await r.close();}
});
test('paired TLS holder receives T2 offer, persists admission, settles once and rejects a forged lease',async()=>{
 const r=await runtime();let ws,ledger;
 try{
  const invite=await r.auth.invite('g1','p1','device1',r.url),paired=await pinnedRequest(invite,'/v2/pair',{inviteId:invite.inviteId,code:invite.code,holderInstanceId:'h1'});
  const capacity=[{resourcePoolId:'memory1',amount:100}];await r.allotments.confirmDevice('device1',capacity,[{groupId:'g1',holderInstanceId:'h1',appInstanceId:null}]);
  ledger=await DurableLedger.open(fs.mkdtempSync(path.join(r.config.dataDir,'holder-')),{groupId:'g1',deviceId:'device1',holderInstanceId:'h1',appInstanceId:null},r.identity.cert);
  ledger.requestGrant('request1');const grant=await pinnedRequest(invite,'/v2/allotments/request',{ledgerEpoch:1,leaseRequestId:'request1',leaseMs:300000,base:[],extra:capacity},paired.credential);ledger.installGrant(grant);
  const f=attempt();f.offer.allotmentId=grant.allotmentId;f.message.senderInstanceId=r.identity.id;f.message.payload=JSON.stringify(f.offer);await r.store.persistOffer(f.offer,'h1',f.message);
  ws=new WebSocket(r.url.replace('https:','wss:')+'/v2/channel',{...pinnedOptions(invite),headers:{Authorization:'Bearer '+paired.credential}});
  const queue=[],waiters=[];ws.on('message',b=>{const m=JSON.parse(b);if(waiters.length)waiters.shift()(m);else queue.push(m);});
  const next=()=>queue.length?Promise.resolve(queue.shift()):new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CHANNEL_TIMEOUT')),5000);waiters.push(m=>{clearTimeout(timer);resolve(m);});});
  await once(ws,'open');let seq=0;
  const send=(type,payload)=>{seq++;ws.send(JSON.stringify({protocolVersion:2,messageId:'message'+seq,type,groupId:'g1',senderInstanceId:'h1',coordinatorEpoch:1,seq,ackOf:null,traceId:'trace1',payload:JSON.stringify(payload),extensions:[]}));};
  send('Hello',{versions:[2],extensions:[]});const offered=await next();assert.equal(offered.type,'DispatchOffer');await next();
  const offer=JSON.parse(offered.payload),entry=ledger.admit(offer,{coordinatorEpoch:1,online:true,ownerIdle:true,admissionLimit:capacity});
  send('AdmissionReply',{attemptId:entry.record.attemptId,holderInstanceId:'h1',status:'ACCEPTED',reasonCode:null,record:entry.record,wait:{value:null,source:'UNKNOWN',sampledAt:0,ttlMs:1000,unit:'ms'}});await next();
  ledger.begin(entry.record.attemptId);let starts=1;
  const receipt={attemptId:entry.record.attemptId,coordinatorEpoch:1,planRevision:1,fence:entry.record.fence,state:'SUCCEEDED',resourcesSettled:true,outputs:[],actualTarget:offer.target,actualConfiguration:'default',errorCode:null};ledger.settle(receipt);
  const report={receipt,allotmentId:grant.allotmentId,allotmentVersion:grant.version,leaseId:entry.record.leaseId,actualModel:null,timings:[]};
  send('ExecutionReceipt',report);await next();assert.equal((await r.db.receipt.findUnique({where:{id:entry.record.attemptId}})).committed,true);
  const duplicate=ledger.admit(offer,{coordinatorEpoch:1,online:true,ownerIdle:true,admissionLimit:capacity});assert.equal(duplicate.record.state,'SUCCEEDED');assert.throws(()=>{ledger.begin(entry.record.attemptId);starts++;},/NOT_STARTABLE/);assert.equal(starts,1);
  send('ExecutionReceipt',report);await next();assert.equal(await r.db.receipt.count(),1);
  const closed=once(ws,'close');send('ExecutionReceipt',{...report,leaseId:'forged'});assert.equal((await closed)[0],1008);
 }finally{ws?.terminate();if(ledger)await ledger.close();await r.close();}
});
