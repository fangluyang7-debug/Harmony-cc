const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./native-coordinator-fixture.cjs');
test('application observations are authenticated, bounded and do not allocate task resources',async()=>{
 const f=fixture(),activity=new (f.load('apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorActivity.ets').CoordinatorActivity)(f.database);
 const peer={groupId:'g',deviceId:'d',holderInstanceId:'h',app:{appId:'a'}},now=Date.now();
 const body={sampledAt:now,processMemoryBytes:100000000,tasks:[{taskId:'search1',operation:'text',phase:'CLOUD_REQUEST',state:'RUNNING',startedAt:now,updatedAt:now,error:''}]};
 await assert.rejects(activity.report({...peer,app:undefined},body),/APP_REGISTRATION_REQUIRED/);
 await assert.rejects(activity.report(peer,{...body,processMemoryBytes:-1}),/APP_ACTIVITY_INVALID/);
 await activity.report(peer,body);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM Attempt').get().n,0);
 const row=f.sql.prepare('SELECT metadataJson FROM Device').get();assert.equal(JSON.parse(row.metadataJson).activity.tasks[0].state,'RUNNING');
 await activity.report(peer,{...body,tasks:[{...body.tasks[0],phase:'FINISHED',state:'SUCCEEDED'}]});
 assert.equal(f.sql.prepare('SELECT count(*) n FROM Device').get().n,1);
});
