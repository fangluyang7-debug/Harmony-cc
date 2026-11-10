const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {runtime}=require('./helpers.cjs'),{registerDeviceMembership,deviceMembershipActive}=require('../dist/device-membership');
test('leaving a device revokes App and device sessions without erasing history; unsettled work prevents leave',async()=>{
 const r=await runtime();try{
  const id=randomUUID(),user=randomUUID(),group=randomUUID();await r.db.spaceUser.create({data:{id:user,account:user,name:'owner',password:'unused'}});await r.db.teamSpace.create({data:{id:group,name:'test',createdAt:Date.now()}});await r.db.spaceDevice.create({data:{id,spaceId:group,userId:user,holderId:'holder',name:'phone',settingsJson:'{}',createdAt:Date.now()}});await r.db.$transaction(tx=>registerDeviceMembership(tx,randomUUID(),id,undefined,user));
  const invite=await r.auth.invite(group,user,id,r.url),paired=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:'holder'});
  const appInvite=await r.apps.register(paired.peer,{label:'photo',allowedContracts:['text.count.v1'],maxConcurrent:1,resources:[{resourcePoolId:'cpu',amount:1}],offlineBase:[],onlineExtra:[]},r.url),app=await r.apps.exchange({registrationId:appInvite.registrationId,code:appInvite.code});
  await assert.rejects(r.auth.leaveDevice(app.peer),/DEVICE_OWNER_REQUIRED/);
  await r.db.attempt.create({data:{id:'busy-leave',groupId:group,workflowId:'w',nodeId:'n',holderInstanceId:'holder',executionDigest:'d',taskJson:'{}',state:'RUNNING',recordJson:'{"resourcesSettled":false}'}});
  await assert.rejects(r.auth.leaveDevice(paired.peer),/SPACE_SWITCH_BUSY/);
  await r.db.attempt.update({where:{id:'busy-leave'},data:{state:'SUCCEEDED',recordJson:'{"resourcesSettled":true}'}});
  assert.equal((await r.auth.leaveDevice(paired.peer)).left,true);assert.equal(await deviceMembershipActive(r.db,id),false);
  await assert.rejects(r.auth.authenticate(paired.credential));await assert.rejects(r.auth.authenticate(app.credential));assert.equal(await r.db.attempt.count(),1);assert.equal(await r.db.spaceDevice.count(),1);
 }finally{await r.close();}
});
