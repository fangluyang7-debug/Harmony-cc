const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {runtime}=require('./helpers.cjs'),{registerDeviceMembership,deviceMembershipActive}=require('../dist/device-membership');
test('one installation has one active space; switching retires credentials, hides old registration, preserves history and rejects busy moves',async()=>{
 const r=await runtime(),installationId=randomUUID(),user='member-owner';
 try{
  await r.db.spaceUser.create({data:{id:user,account:user,name:'owner',password:'unused'}});
  for(const g of ['space-a','space-b']){await r.db.teamSpace.create({data:{id:g,name:g,createdAt:Date.now()}});await r.db.spaceMember.create({data:{id:randomUUID(),spaceId:g,userId:user,role:'OWNER',joinedAt:Date.now()}});}
  await r.db.spaceDevice.create({data:{id:'legacy-device',spaceId:'space-a',userId:user,holderId:'legacy-holder',name:'legacy',settingsJson:'{}',createdAt:Date.now()}});
  const legacyInvite=await r.auth.invite('space-a',user,'legacy-device',r.url),legacy=await r.auth.exchange({inviteId:legacyInvite.inviteId,code:legacyInvite.code,holderInstanceId:'legacy-holder'});
  const create=async(group,id,previous)=>{
   await r.db.$transaction(async tx=>{await tx.spaceDevice.create({data:{id,spaceId:group,userId:user,holderId:'holder-'+id,name:id,settingsJson:'{}',createdAt:Date.now()}});await registerDeviceMembership(tx,installationId,id,previous,user,['legacy-device']);});
   const i=await r.auth.invite(group,user,id,r.url);return {inviteId:i.inviteId,code:i.code,holderInstanceId:'holder-'+id};
  };
  const first=await r.auth.exchange(await create('space-a','device-a'));
  assert.equal(await deviceMembershipActive(r.db,'device-a'),true);
  await assert.rejects(r.auth.authenticate(legacy.credential),/REVOKED/);
  const request=await create('space-b','device-b','device-a');
  assert.equal(await deviceMembershipActive(r.db,'device-a'),true);assert.equal(await deviceMembershipActive(r.db,'device-b'),false,'preparing an invite must not evict current device');
  // Explicit unresolved work prevents an invitation from becoming a second active membership.
  await r.db.attempt.create({data:{id:'busy-work',groupId:'space-a',workflowId:'workflow',nodeId:'node',holderInstanceId:'holder-device-a',executionDigest:'digest',taskJson:'{}',state:'RUNNING',offerJson:'{}',recordJson:JSON.stringify({resourcesSettled:false})}});
  await assert.rejects(r.auth.exchange(request),/SPACE_SWITCH_BUSY/);
  assert.equal((await r.auth.authenticate(first.credential)).deviceId,'device-a');
  await r.db.attempt.update({where:{id:'busy-work'},data:{state:'SUCCEEDED',recordJson:JSON.stringify({resourcesSettled:true})}});
  const registration={label:'space-bound app',allowedContracts:['text.count.v1'],maxConcurrent:1,resources:[{resourcePoolId:'cpu',amount:1}],offlineBase:[],onlineExtra:[]};
  const appInvite=await r.apps.register(first.peer,registration,r.url),app=await r.apps.exchange({registrationId:appInvite.registrationId,code:appInvite.code});
  const pendingInvite=await r.apps.register(first.peer,{...registration,label:'pending app'},r.url);
  await r.db.$transaction(tx=>r.apps.reserveJob(tx,app.peer,'pending-app-job',[{resourcePoolId:'cpu',amount:1}],Date.now()+30000));
  await assert.rejects(r.auth.exchange(request),/SPACE_SWITCH_BUSY/);
  await r.db.appJobReservation.update({where:{id:'pending-app-job'},data:{deadlineAt:Date.now()-1000}});
  await assert.rejects(r.auth.exchange(request),/SPACE_SWITCH_BUSY/,'expiry alone must not release unknown work');
  await r.db.attempt.create({data:{id:'pending-app-job',groupId:'space-a',workflowId:'app-workflow',nodeId:'node',holderInstanceId:'remote-holder',executionDigest:'digest',taskJson:'{}',state:'SUCCEEDED',recordJson:JSON.stringify({resourcesSettled:false})}});
  await assert.rejects(r.auth.exchange(request),/SPACE_SWITCH_BUSY/,'terminal state alone must not release unacknowledged resources');
  await r.db.attempt.update({where:{id:'pending-app-job'},data:{recordJson:JSON.stringify({resourcesSettled:true})}});
  const retired=[];r.auth.onRevoked(id=>retired.push(id));const next=await r.auth.exchange(request);
  assert.ok(retired.includes(first.peer.credentialId));await assert.rejects(r.auth.authenticate(first.credential),/REVOKED/);
  await assert.rejects(r.auth.authenticate(app.credential),/REVOKED/);
  assert.equal((await r.db.registeredInstallation.findUnique({where:{id:pendingInvite.registrationId}})).state,'REVOKED');
  await assert.rejects(r.apps.exchange({registrationId:pendingInvite.registrationId,code:pendingInvite.code}));
  assert.equal((await r.auth.authenticate(next.credential)).groupId,'space-b');
  assert.equal(await r.db.appJobReservation.count({where:{id:'pending-app-job'}}),1,'settled reservation history is preserved');
  assert.equal(await deviceMembershipActive(r.db,'device-a'),false);assert.equal(await deviceMembershipActive(r.db,'device-b'),true);
  assert.equal((await r.spaces.dashboard(user,'space-a')).devices.length,0);assert.equal((await r.spaces.dashboard(user,'space-b')).devices.length,1);
  assert.equal(await r.db.spaceDevice.count(),3);assert.equal((await r.db.attempt.findUnique({where:{id:'busy-work'}})).state,'SUCCEEDED');
  assert.equal(await r.directory.hasDispatchCredit(r.db,{target:{deviceId:'device-a'},task:{}},'holder-device-a'),false);
  const back=await r.auth.exchange(await create('space-a','device-a-new','device-b'));
  await assert.rejects(r.auth.authenticate(next.credential),/REVOKED/);assert.equal(await deviceMembershipActive(r.db,back.peer.deviceId),true);
  assert.equal((await r.spaces.dashboard(user,'space-b')).devices.length,0);
 }finally{await r.close();}
});
