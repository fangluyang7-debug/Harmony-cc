const {test}=require('node:test'),assert=require('node:assert/strict'),https=require('node:https'),{randomUUID}=require('node:crypto');
const {AppActivityStore}=require('../dist/app-activity');
const peer={groupId:'g',deviceId:'d',holderInstanceId:'h',app:{appId:'a'}};
const sample=now=>({sampledAt:now,processMemoryBytes:1024,processCpuUsage:0,tasks:[{taskId:'task-1',operation:'image_upload',phase:'FINISHED',state:'FAILED',error:'POLICY_REJECTED',startedAt:now-100,updatedAt:now}]});

test('Short task evidence stays visible after settlement without inventing quota or attributing another device work',async()=>{
 const {deviceExecutionMarkup}=await import('../../../apps/team-space-web/dispatch-activity.mjs');
 const jobs=[{id:'done',deviceId:'pc',originDeviceId:'phone',state:'SUCCEEDED',resourcesSettled:true,capability:'catalog.filter.v1',createdAt:1},
  {id:'rejected',deviceId:'pc',state:'REJECTED',resourcesSettled:true,capability:'catalog.filter.v1',createdAt:2},
  {id:'foreign',deviceId:'phone',state:'SUCCEEDED',resourcesSettled:true,createdAt:3}];
 const html=deviceExecutionMarkup('pc',jobs,()=>'<筛选>');
 assert.match(html,/成功任务<\/label><strong>1</);assert.match(html,/资源已释放<\/label><strong>1</);
 assert.match(html,/data-job="done"/);assert.match(html,/来自其他设备的任务/);assert.match(html,/&lt;筛选&gt;/);
 assert.doesNotMatch(html,/foreign/);assert.match(html,/不是 CPU 使用率或应用内存/);
 assert.match(deviceExecutionMarkup('idle',jobs),/暂无派发到本设备的任务/);
});
test('App observations preserve zero, reject device impersonation, isolate and expire without mutating input',()=>{
 let now=100000;const store=new AppActivityStore(()=>now),s=sample(now);store.report(peer,s);s.tasks[0].error='changed';
 assert.equal(store.read('g','d',['h'])[0].activity.tasks[0].error,'POLICY_REJECTED');
 assert.equal(store.read('g','d',['h'])[0].activity.processCpuUsage,0);
 assert.deepEqual(store.read('other','d',['h']),[]);assert.deepEqual(store.read('g','d',['other']),[]);
 assert.throws(()=>store.report({...peer,app:undefined},sample(now)),/REGISTRATION/);
 assert.throws(()=>store.report(peer,{...sample(now),deviceId:'forged'}),/INVALID/);
 assert.throws(()=>store.report(peer,{...sample(now),processCpuUsage:Infinity}),/INVALID/);
 assert.throws(()=>store.report(peer,{...sample(now),tasks:Array(21).fill(sample(now).tasks[0])}),/INVALID/);
 store.report(peer,sample(now-1));assert.equal(store.read('g','d',['h'])[0].activity.sampledAt,now);
 now+=15000;assert.deepEqual(store.read('g','d',['h']),[]);
});
test('App rendering distinguishes business failures from execution receipts and escapes text',async()=>{
 const {appActivityMarkup}=await import('../../../apps/team-space-web/dispatch-activity.mjs');const now=100000;
 const html=appActivityMarkup([{appId:'a',receivedAt:now,activity:sample(now)}],[{id:'a',label:'<SoleAI>'}],now);
 assert.match(html,/0.0%/);assert.match(html,/图片检索 · 失败/);assert.match(html,/跨设备执行以调度回执为准/);assert.match(html,/&lt;SoleAI&gt;/);
 assert.equal(appActivityMarkup([{receivedAt:now,activity:sample(now)}],[],now+15000),'');
});
test('authenticated activity endpoint accepts registered App only and changes no scheduler records',async()=>{
 const {runtime}=require('./helpers.cjs');const r=await runtime();
 const request=(token,body)=>new Promise((resolve,reject)=>{const q=https.request(r.url+'/v2/apps/me/activity',{ca:r.identity.cert,method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b)}));});q.on('error',reject);q.end(JSON.stringify(body));});
 try{
  const invite=await r.auth.invite('activity-group','owner','phone',r.url),owner=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:randomUUID()});
  const capacity=[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:268435456}];
  await r.allotments.confirmDevice(owner.peer.deviceId,capacity,[{groupId:owner.peer.groupId,holderInstanceId:owner.peer.holderInstanceId,appInstanceId:null}]);
  const reg=await r.apps.register(owner.peer,{label:'SoleAI',allowedContracts:['text.count.v1'],maxConcurrent:1,resources:capacity,offlineBase:[],onlineExtra:[]},r.url);
  const app=await r.apps.exchange({registrationId:reg.registrationId,code:reg.code});
  const before=await Promise.all([r.db.device.count(),r.db.attempt.count(),r.db.outbox.count()]);
  assert.equal((await request(null,sample(Date.now()))).status,401);
  assert.equal((await request(owner.credential,sample(Date.now()))).status,400);
  assert.equal((await request(app.credential,sample(Date.now()))).body.accepted,true);
  assert.deepEqual(await Promise.all([r.db.device.count(),r.db.attempt.count(),r.db.outbox.count()]),before);
 }finally{await r.close();}
});
