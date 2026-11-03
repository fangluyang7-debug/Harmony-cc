const {test}=require('node:test'),assert=require('node:assert/strict');
const {CpuJobs}=require('../dist/cpu-jobs');
for(const state of ['WAITING_INPUT','DISPATCHING'])test(`persisted attempt in ${state} never replans or rereads input`,async()=>{
 const jobs=Object.create(CpuJobs.prototype),offer={task:{coordinatorEpoch:1}},data={holderId:'h',offer};let flushed=0,updated=0;
 jobs.owned=async()=>data;jobs.epoch=()=>1;jobs.flush=async()=>flushed++;jobs.status=async()=>({state:'OFFERED'});
 jobs.inputReady=async()=>{throw Error('must not reread expired input');};jobs.choose=async()=>{throw Error('must not replan');};
 jobs.db={cpuJob:{findUniqueOrThrow:async()=>({state}),updateMany:async()=>{updated++;return {count:1};}},attempt:{findUnique:async()=>({groupId:'g',holderInstanceId:'h',offerJson:JSON.stringify(offer)})}};
 assert.deepEqual(await jobs.startAttempt({groupId:'g'},'j'),{state:'OFFERED'});assert.equal(flushed,1);assert.equal(updated,1);
});
