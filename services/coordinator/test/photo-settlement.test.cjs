const {test}=require('node:test'),assert=require('node:assert/strict');
const {CpuJobs}=require('../dist/cpu-jobs');
test('admitted output settles during a transient calibration window; new work and revoked evidence stay blocked',async()=>{
 const jobs=Object.create(CpuJobs.prototype),peer={groupId:'g',holderInstanceId:'h',deviceId:'d'};
 let state='RUNNING',admission='WAITING_WINDOW',reason='OWNER_OR_HOST_NOT_AVAILABLE',sampledAt=Date.now(),registered=0;
 const d={offer:{target:{deviceId:'d',targetId:'t'},task:{coordinatorEpoch:1,contract:{outputSchemas:['photo.tile']}}},input:{ref:{schemaId:'photo.tile'},bytes:1}};
 Object.assign(jobs,{db:{cpuJob:{findUnique:async()=>({groupId:'g',state:'DISPATCHED',metadataJson:JSON.stringify(d)}),update:async()=>{}},attempt:{findUnique:async()=>({holderInstanceId:'h',state})}},epoch:()=>1,
  directory:{domain:'SIMULATED',qualification:async()=>({admission:{state:admission,reasonCode:reason,quality:{value:1,source:'SIMULATED',sampledAt,ttlMs:60000,unit:'score'}}})},
  artifacts:{register:()=>{registered++;},issue:()=>({ticket:'verified'})},localOutput:()=>false});
 const body={bytes:8,contentHash:'a'.repeat(64),schemaId:'photo.tile'};
 assert.equal((await jobs.execution(peer,'attempt','output',body)).delivery,'RELAY');assert.equal(registered,1);
 await assert.rejects(jobs.execution(peer,'attempt','authorize',{}),/CAPABILITY_NOT_QUALIFIED/);
 state='OFFERED';await assert.rejects(jobs.execution(peer,'attempt','output',body),/CAPABILITY_NOT_QUALIFIED/);
 state='RUNNING';admission='SUSPENDED';reason='QUALITY_EVALUATION_FAILED';await assert.rejects(jobs.execution(peer,'attempt','output',body),/CAPABILITY_NOT_QUALIFIED/);
 admission='WAITING_RESOURCE';reason='EVALUATION_RESOURCE_REQUIRED';sampledAt=Date.now()-70000;await assert.rejects(jobs.execution(peer,'attempt','output',body),/CAPABILITY_NOT_QUALIFIED/);
 sampledAt=Date.now();assert.equal((await jobs.execution(peer,'attempt','output',body)).delivery,'RELAY');
});
