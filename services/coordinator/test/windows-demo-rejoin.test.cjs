const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {runtime}=require('./helpers.cjs'),{attempt}=require('./fixtures.cjs');
const {registerDeviceMembership}=require('../dist/device-membership');

test('three installations repeatedly pair and leave concurrently without retaining active credentials',async()=>{
 const r=await runtime();try{
  const user='demo-owner',group='demo';await r.db.spaceUser.create({data:{id:user,account:user,name:user,password:'unused'}});await r.db.teamSpace.create({data:{id:group,name:group,createdAt:Date.now()}});
  const devices=[];
  for(const name of ['phone','pc-b','harmony-pc']){
   await r.db.spaceDevice.create({data:{id:name,spaceId:group,userId:user,holderId:'holder-'+name,name,settingsJson:'{}',createdAt:Date.now()}});
   const installationId=randomUUID(),invitation=await r.auth.invite(group,user,name,r.url),short=r.auth.issuePairingCode(invitation);
   devices.push({installationId,invitation,short,holderInstanceId:'holder-'+name});
  }
  for(let round=0;round<6;round++){
   const pairs=await Promise.all(devices.map(async d=>{const boot=await r.auth.redeemPairingCode(d.short.pairingCode,r.url,d.holderInstanceId);return r.auth.exchange({inviteId:boot.invitation.inviteId,code:boot.invitation.code,holderInstanceId:d.holderInstanceId,installationId:d.installationId});}));
   assert.equal(await r.db.credential.count({where:{revoked:false}}),3);
   await Promise.all(pairs.map(async p=>{assert.equal((await r.auth.authenticate(p.credential)).groupId,group);await r.auth.leaveDevice(p.peer);}));
   assert.equal(await r.db.credential.count({where:{revoked:false}}),0);
  }
  assert.equal(await r.db.spaceDevice.count(),3);assert.equal(await r.db.credential.count(),18);
 }finally{await r.close();}
});

test('missing unadmitted old-epoch execution cannot permanently prevent device re-pairing',async()=>{
 const r=await runtime();try{
  const f=attempt();f.task.contract.sideEffectPolicy='PURE';f.offer.task=f.task;f.message.payload=JSON.stringify(f.offer);f.message.senderInstanceId=r.identity.id;
  await r.store.persistOffer(f.offer,'h1',f.message);
  await r.store.requestStatus('g1','h1',1);let q=await r.db.outbox.findFirst({where:{kind:'AttemptStatusQuery',epoch:1,acked:false}});
  await r.store.reconcileStatus('g1','h1','device1',JSON.parse(q.messageJson).messageId,{attemptId:f.task.attemptId,record:null},1);
  const old='device1',installation=randomUUID();await r.db.spaceUser.create({data:{id:'p1',account:'p1',name:'p1',password:'unused'}});await r.db.teamSpace.create({data:{id:'g1',name:'demo',createdAt:Date.now()}});
  for(const [id,holder] of [[old,'h1'],['new-device','new-holder']])await r.db.spaceDevice.create({data:{id,spaceId:'g1',userId:'p1',holderId:holder,name:id,settingsJson:'{}',createdAt:Date.now()}});
  await r.db.$transaction(tx=>registerDeviceMembership(tx,installation,old,undefined,'p1'));
  const invite=await r.auth.invite('g1','p1','new-device',r.url),request={inviteId:invite.inviteId,code:invite.code,holderInstanceId:'new-holder',installationId:installation,previousDeviceId:old,knownDeviceIds:[old]};
  await assert.rejects(r.auth.exchange(request),/SPACE_SWITCH_BUSY/);
  await r.store.recover(2);
  assert.equal((await r.db.attempt.findUnique({where:{id:f.task.attemptId}})).state,'CANCELLED');
  assert.equal(await r.db.receipt.count(),0);assert.equal(await r.db.outbox.count({where:{attemptId:f.task.attemptId,acked:false,superseded:false}}),0);
  await r.db.attempt.update({where:{id:f.task.attemptId},data:{recordJson:JSON.stringify(f.record)}});await assert.rejects(r.auth.exchange(request),/SPACE_SWITCH_BUSY/,'actual unsettled admission overrides a closure marker');
  await r.db.attempt.update({where:{id:f.task.attemptId},data:{recordJson:null}});
  assert.equal((await r.auth.exchange(request)).peer.deviceId,'new-device');
  assert.equal(await r.db.attempt.count(),1,'audit history retained');
 }finally{await r.close();}
});
