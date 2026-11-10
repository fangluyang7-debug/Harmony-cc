const {test}=require('node:test'),assert=require('node:assert/strict'),https=require('node:https'),crypto=require('node:crypto');
const {runtime}=require('./helpers.cjs');
const contracts=['photo.analyze.v1','photo.prepare.v1','photo.enhance.v1','photo.assemble.v1','photo.deliver.v1'];
test('independent photo App uses its credential without browser login, retains source identity and isolates records',async()=>{
 const r=await runtime();try{
  const invitation=await r.auth.invite('g1','owner1','phone1',r.url),owner=await r.auth.exchange({inviteId:invitation.inviteId,code:invitation.code,holderInstanceId:'holder1'});
  await r.db.spaceUser.create({data:{id:'owner1',account:'photo-test',name:'Owner',password:'unused'}});
  await r.db.teamSpace.create({data:{id:'g1',name:'Photo test',createdAt:Date.now()}});
  await r.db.spaceDevice.create({data:{id:'phone1',spaceId:'g1',userId:'owner1',holderId:'holder1',name:'Phone',settingsJson:'{}',createdAt:Date.now()}});
  const registration=label=>({label,allowedContracts:contracts,maxConcurrent:4,resources:[{resourcePoolId:'cpu',amount:4}],offlineBase:[],onlineExtra:[]});
  const enroll=async label=>{const a=await r.apps.register(owner.peer,registration(label),r.url);return r.apps.exchange({registrationId:a.registrationId,code:a.code});};
  const a=await enroll('Photo'),b=await enroll('Other photo');
  const capacity=[{resourcePoolId:'cpu',amount:4},{resourcePoolId:'ram',amount:2147483648}];
  await r.allotments.confirmDevice('phone1',capacity,[{groupId:'g1',holderInstanceId:'holder1',appInstanceId:null}]);
  const identity=await new Promise((resolve,reject)=>{https.get(r.url+'/v2/apps/me',{ca:r.identity.cert,headers:{Authorization:'Bearer '+a.credential}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve(JSON.parse(Buffer.concat(chunks))));}).on('error',reject);});
  assert.deepEqual(identity.deviceCapacity,capacity);assert.equal(identity.identity.appInstanceId,a.peer.app.appInstanceId);
  const rpc=(credential,message)=>new Promise((resolve,reject)=>{const body=JSON.stringify(message),q=https.request(r.url+'/v2/apps/photo',{ca:r.identity.cert,method:'POST',headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json'}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});q.on('error',reject);q.end(body);});
  const data=Buffer.alloc(1100000,7),hash=crypto.createHash('sha256').update(data).digest('hex');
  const created=await rpc(a.credential,{route:'/photo-runs',method:'POST',body:{mode:'LOCAL',sourceDeviceId:'forged',budgetMs:180000,inputs:[{name:'input.png',hash,bytes:data.length}]}});
  assert.equal(created.status,201);const run=created.body;assert.equal(run.sourceDeviceId,'phone1');assert.equal(run.appInstanceId,a.peer.app.appInstanceId);
  const preview=await rpc(a.credential,{route:'/photo-runs/'+run.id+'/input?image=0',method:'PUT',data:data.toString('base64')});assert.equal(preview.status,201);
  const read=await rpc(a.credential,{route:'/photo-runs/'+run.id+'/input?image=0'});assert.deepEqual(Buffer.from(read.body.data,'base64'),data);
  assert.equal((await rpc(b.credential,{route:'/photo-runs/'+run.id})).body.error,'PHOTO_APP_SCOPE');
  assert.deepEqual((await rpc(b.credential,{route:'/photo-runs'})).body,[]);
  assert.equal((await rpc(owner.credential,{route:'/photo-runs'})).body.error,'APP_REGISTRATION_REQUIRED');
  assert.equal((await rpc(a.credential,{route:'/photo-runs/'+run.id,method:'POST',body:{revision:0,state:'SUCCEEDED'}})).body.error,'PHOTO_RESULTS_NOT_COMMITTED');
  assert.equal((await rpc(a.credential,{route:'/photo-runs/'+run.id+'/capture-result?image=0',method:'POST',body:{}})).body.error,'PHOTO_JOB_SCOPE');
  const view=await r.spaces.appPhoto(a.peer,{route:'/photo-runs/'+run.id});assert.equal(view.images[0].inputAvailable,true);assert.equal(view.allCommitted,false);
 }finally{await r.close();}
});
