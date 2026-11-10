const {test}=require('node:test'),assert=require('node:assert/strict');
const {runtime}=require('./helpers.cjs'),{pinnedRequest}=require('../dist/pinned-client');
const capacity=[{resourcePoolId:'cpu',amount:2},{resourcePoolId:'ram',amount:268435456}],base=[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:67108864}];
const registration=label=>({label,allowedContracts:['text.count.v1'],maxConcurrent:1,resources:capacity,offlineBase:base,onlineExtra:[]});
test('new installed console capabilities require a submit confirmation; native grants remain separate',async()=>{
 const r=await runtime();try{
  const owner={groupId:'catalog-grant',principalId:'account',deviceId:'web-account',holderInstanceId:'web-account',credentialId:'web-account'};
  const old=await r.apps.console(owner,['text.count.v1'],capacity);
  assert.deepEqual((await r.apps.console(owner,['text.count.v1','catalog.filter.v1'],capacity)).app.allowedContracts,['text.count.v1']);
  const updated=await r.apps.console(owner,['text.count.v1','catalog.filter.v1'],capacity,true);
  assert.equal(updated.app.appInstanceId,old.app.appInstanceId);assert.equal(updated.credentialId,old.credentialId);
  assert.deepEqual((await r.apps.context(updated)).identity.allowedContracts,['text.count.v1','catalog.filter.v1']);
 }finally{await r.close();}
});
test('one browser account can submit in multiple spaces while legacy installations remain readable',async()=>{
 const r=await runtime();try{
  const owner={groupId:'g1',principalId:'account',deviceId:'web-account',holderInstanceId:'web-account',credentialId:'web-account'};
  const first=await r.apps.console(owner,['text.count.v1'],capacity);
  // Reproduce the pre-upgrade holder binding without changing its App identity.
  await r.db.registeredInstallation.update({where:{id:first.app.appInstanceId},data:{holderInstanceId:owner.holderInstanceId}});
  const cred=await r.db.credential.findUniqueOrThrow({where:{id:first.credentialId}}),data=JSON.parse(cred.metadataJson);data.peer.holderInstanceId=owner.holderInstanceId;
  await r.db.credential.update({where:{id:cred.id},data:{holderInstanceId:owner.holderInstanceId,metadataJson:JSON.stringify(data)}});
  const second=await r.apps.console({...owner,groupId:'g2'},['text.count.v1'],capacity),again=await r.apps.console(owner,['text.count.v1'],capacity);
  assert.notEqual(second.holderInstanceId,again.holderInstanceId);assert.equal(again.holderInstanceId,owner.holderInstanceId);assert.equal(again.app.appInstanceId,first.app.appInstanceId);
  assert.deepEqual((await r.apps.context(second)).identity,second.app);assert.deepEqual((await r.apps.context(again)).identity,again.app);
  assert.equal((await r.apps.console({...owner,groupId:'g2'},['text.count.v1'],capacity)).holderInstanceId,second.holderInstanceId);
 }finally{await r.close();}
});
async function owner(r){const invite=await r.auth.invite('g1','owner1','device1',r.url),paired=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:'owner-holder'});await r.allotments.confirmDevice('device1',capacity,[{groupId:'g1',holderInstanceId:paired.peer.holderInstanceId,appInstanceId:null}]);return {invite,...paired};}
test('owner-confirmed one-use registration derives App identity, reserves offline capacity before delivery and rejects self-grants',async()=>{
 const r=await runtime();try{
  const o=await owner(r),post=(route,body,token=o.credential)=>pinnedRequest(o.invite,route,body,token);
  const a=await post('/v2/apps/registrations',registration('App A')),b=await post('/v2/apps/registrations',registration('App B'));
  await assert.rejects(post('/v2/apps/registrations',registration('App C')),/APP_BASE_BUDGET_UNAVAILABLE|400/);
  const app=await post('/v2/apps/exchange',{registrationId:a.registrationId,code:a.code});
  assert.equal(app.peer.deviceId,o.peer.deviceId);assert.equal(app.peer.principalId,o.peer.principalId);assert.equal(app.peer.app.appId,a.appId);assert.notEqual(app.credential,o.credential);
  assert.deepEqual((await r.auth.authenticate(app.credential)).app,app.peer.app);
  await assert.rejects(post('/v2/apps/exchange',{registrationId:a.registrationId,code:a.code}),/400/);
  await assert.rejects(post('/v2/apps/registrations',registration('forged'),app.credential),/400/);
  await assert.rejects(post('/v2/apps/exchange',{registrationId:b.registrationId,code:b.code,appId:a.appId}),/400/);
  await r.db.registeredInstallation.update({where:{id:b.registrationId},data:{expiresAt:0}});
  await assert.rejects(post('/v2/apps/exchange',{registrationId:b.registrationId,code:b.code}),/400/);
  const req={ledgerEpoch:1,leaseRequestId:'app-grant',leaseMs:30000,base,extra:[]};
  const grant=await r.allotments.issue(app.peer,req);assert.equal(grant.appInstanceId,a.appInstanceId);assert.deepEqual(grant.base,base);
  await assert.rejects(r.allotments.issue(app.peer,{...req,leaseRequestId:'forged-base',base:capacity}),/APP_ALLOTMENT_POLICY/);
  await assert.rejects(r.allotments.issue(o.peer,{...req,base:[],extra:capacity}),/BUDGET_UNAVAILABLE/);
  await assert.rejects(r.allotments.confirmDevice('device1',[{resourcePoolId:'cpu',amount:1}],[]),/BUDGET_INVALID|RECONCILIATION/);
  await post('/v2/apps/registrations/'+a.appInstanceId+'/revoke',{});await assert.rejects(r.auth.authenticate(app.credential),/CREDENTIAL_REVOKED|APP_CREDENTIAL_REVOKED/);
  await assert.rejects(post('/v2/apps/registrations',registration('App C')),/400/,'revocation cannot reclaim an offline grant without settlement');
  const current=await r.db.registeredInstallation.findUnique({where:{id:a.appInstanceId}});assert.equal(current.state,'REVOKED');assert.deepEqual(JSON.parse(current.offlineJson),base);
 }finally{await r.close();}
});
test('logical App concurrency/resource quota is shared across installations and queued reservations are bounded',async()=>{
 const r=await runtime();try{
  const o=await owner(r),a=await r.apps.register(o.peer,registration('shared App'),r.url),aa=await r.apps.exchange({registrationId:a.registrationId,code:a.code});
  const b=await r.apps.register(o.peer,{...registration('shared App'),appId:a.appId,offlineBase:[]},r.url),bb=await r.apps.exchange({registrationId:b.registrationId,code:b.code});
  assert.equal(aa.peer.app.appId,bb.peer.app.appId);assert.notEqual(aa.peer.app.appInstanceId,bb.peer.app.appInstanceId);
  await assert.rejects(r.apps.register(o.peer,{...registration('shared App'),appId:a.appId,offlineBase:capacity},r.url),/APP_BASE_QUOTA_UNAVAILABLE/);
  const rotated=await r.auth.rotate(bb.credential);assert.deepEqual((await r.auth.authenticate(rotated.credential)).app,bb.peer.app);await assert.rejects(r.auth.authenticate(bb.credential),/CREDENTIAL_REVOKED/);
  await r.db.$transaction(async tx=>{await r.apps.reserveJob(tx,aa.peer,'job1',base,Date.now()+30000);await tx.cpuJob.create({data:{id:'job1',groupId:'g1',principalId:aa.peer.principalId,sourceHolderId:aa.peer.holderInstanceId,state:'WAITING_INPUT',metadataJson:'{}'}});});
  await assert.rejects(r.db.$transaction(tx=>r.apps.reserveJob(tx,bb.peer,'job2',base,Date.now()+30000)),/APP_QUOTA_EXCEEDED/);
  await r.db.cpuJob.update({where:{id:'job1'},data:{state:'CANCELLED'}});
  await r.db.$transaction(tx=>r.apps.reserveJob(tx,bb.peer,'job2',base,Date.now()+30000));
  await assert.rejects(r.db.$transaction(tx=>r.apps.reserveJob(tx,bb.peer,'large',[{resourcePoolId:'cpu',amount:3}],Date.now()+30000)),/APP_QUOTA_EXCEEDED/);
 }finally{await r.close();}
});
