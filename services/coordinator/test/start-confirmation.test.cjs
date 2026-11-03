const {test}=require('node:test'),assert=require('node:assert/strict');
const {CpuJobs}=require('../dist/cpu-jobs');
function fixture(){
 const jobs=Object.create(CpuJobs.prototype),listeners=new Set(),grant={version:2,coordinatorEpoch:1,groupId:'g',holderInstanceId:'h'};
 let ack=1,state='WAITING_INPUT';jobs.epoch=()=>1;jobs.owned=async()=>({deadlineAt:Date.now()+10000});jobs.db={cpuJob:{findUniqueOrThrow:async()=>({state})}};
 jobs.allotments={watch:(_g,_h,fn)=>{listeners.add(fn);return ()=>listeners.delete(fn);},reservations:async()=>{assert.equal(listeners.size,1);return [{grant,ack:{version:ack}}];}};
 return {jobs,listeners,confirm(notify=true){ack=2;if(notify)for(const fn of listeners)fn();},cancel(){state='CANCELLED';}};
}
for(const timing of ['before','after','lost-notification'])test(`confirmation ${timing} is read from storage without leaking listeners`,async()=>{
 const f=fixture();if(timing==='before')f.confirm();
 const result=f.jobs.confirmedGrant({groupId:'g'},'d','h',{until:Date.now()+1000,jobId:'j'});
 if(timing!=='before')setTimeout(()=>f.confirm(timing!=='lost-notification'),10);
 assert.equal((await result).version,2);assert.equal(f.listeners.size,0);
});
test('missing confirmation times out and cancellation prevents admission',async()=>{
 const f=fixture();await assert.rejects(f.jobs.confirmedGrant({groupId:'g'},'d','h',{until:Date.now()+20,jobId:'j'}),/ALLOTMENT_ACK_PENDING/);assert.equal(f.listeners.size,0);
 f.cancel();await assert.rejects(f.jobs.confirmedGrant({groupId:'g'},'d','h',{until:Date.now()+20,jobId:'j'}),/JOB_CANCELLED/);assert.equal(f.listeners.size,0);
});

test('cancellation and permission revocation during confirmation do not admit work',async()=>{
 for(const revoked of [false,true]){
  const f=fixture(),pending=f.jobs.confirmedGrant({groupId:'g'},'d','h',{until:Date.now()+1000,jobId:'j'});
  setTimeout(()=>{if(revoked)f.jobs.owned=async()=>{throw Error('APP_REVOKED');};else f.cancel();},10);
  await assert.rejects(pending,revoked?/APP_REVOKED/:/JOB_CANCELLED/);assert.equal(f.listeners.size,0);
 }
});
