const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./native-coordinator-fixture.cjs');
test('live CPU samples and terminal timeouts update without poisoning later reports',async()=>{
 const f=fixture(),activity=new (f.load('apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorActivity.ets').CoordinatorActivity)(f.database);
 const peer={groupId:'g',deviceId:'d',holderInstanceId:'h',app:{appId:'a'}},now=Date.now();
 const body={sampledAt:now,processMemoryBytes:100000000,processCpuUsage:0.12,tasks:[{taskId:'search1',operation:'text',phase:'FINISHED',state:'TIMED_OUT',startedAt:now,updatedAt:now,error:''}]};
 await activity.report(peer,body);
 await assert.rejects(activity.report(peer,{...body,processCpuUsage:-1}),/APP_ACTIVITY_INVALID/);
 await assert.rejects(activity.report(peer,{...body,processCpuUsage:Infinity}),/APP_ACTIVITY_INVALID/);
 await activity.report(peer,{...body,processCpuUsage:0.03,processMemoryBytes:110000000});
 const stored=JSON.parse(f.sql.prepare('SELECT metadataJson FROM Device').get().metadataJson).activity;
 assert.equal(stored.processCpuUsage,0.03);assert.equal(stored.processMemoryBytes,110000000);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM Attempt').get().n,0);
});
