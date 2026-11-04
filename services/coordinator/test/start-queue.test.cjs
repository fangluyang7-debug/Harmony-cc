const {test}=require('node:test'),assert=require('node:assert/strict');
const {CpuJobs}=require('../dist/cpu-jobs');
test('same-job starts serialize, other jobs proceed and failed starts release the queue',async()=>{
 const jobs=Object.create(CpuJobs.prototype);jobs.starts=new Map();
 jobs.owned=async()=>({offer:{task:{priority:'REMOTE_INTERACTIVE'}}});jobs.batch={hasBacklog:()=>false};
 let release;const gate=new Promise(resolve=>release=resolve),events=[];
 jobs.startAttempt=async(_peer,id)=>{events.push(id);if(id==='first'&&events.filter(x=>x==='first').length===1){await gate;throw Error('PLAN_STALE');}return id;};
 const first=jobs.start({},'first');const failure=assert.rejects(first,/PLAN_STALE/);
 await new Promise(resolve=>setImmediate(resolve));const second=jobs.start({},'first');
 assert.equal(await jobs.start({},'other'),'other');assert.deepEqual(events,['first','other']);
 release();await failure;assert.equal(await second,'first');await new Promise(resolve=>setImmediate(resolve));assert.equal(jobs.starts.size,0);
});
