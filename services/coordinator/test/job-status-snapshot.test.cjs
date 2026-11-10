const {test}=require('node:test'),assert=require('node:assert/strict');
const {CpuJobs}=require('../dist/cpu-jobs');

test('status sees a single snapshot when a receipt commits between attempt and receipt reads',async()=>{
 const peer={groupId:'group',principalId:'owner',holderInstanceId:'source'},ref={artifactId:'out-job'},output={ref};
 const data={offer:{target:{targetId:'cpu',deviceId:'worker'},task:{coordinatorEpoch:1,planRevision:1},allotmentId:'grant',allotmentVersion:1},output,traceId:'trace'};
 let live={row:{...peer,sourceHolderId:'source',state:'DISPATCHED',metadataJson:JSON.stringify(data)},attempt:{state:'ACCEPTED'},receipt:null},commit=true;
 const accessors=snapshot=>({
  cpuJob:{findUnique:async()=>structuredClone(snapshot().row),findUniqueOrThrow:async()=>structuredClone(snapshot().row)},
  attempt:{findUnique:async()=>{const old=structuredClone(snapshot().attempt);if(commit){commit=false;live.attempt={state:'SUCCEEDED'};live.receipt={committed:true,recordJson:JSON.stringify({state:'SUCCEEDED',outputs:[ref]})};}return old;}},
  receipt:{findUnique:async()=>structuredClone(snapshot().receipt)},batchReadyJob:{findUnique:async()=>null}
 });
 const db={...accessors(()=>live),$transaction:async work=>{const snapshot=structuredClone(live);return work(accessors(()=>snapshot));},$queryRaw:async(strings,id)=>{
  assert.equal(id,'job');assert.ok(strings.join('?').includes('WHERE j.id=?'));
  const snapshot=structuredClone(live);
  // A commit after a SELECT's snapshot cannot alter individual fields of its result.
  await accessors(()=>live).attempt.findUnique();
  return [{...snapshot.row,attemptState:snapshot.attempt?.state??null,rejectionJson:null,receiptJson:snapshot.receipt?.recordJson??null,receiptCommitted:snapshot.receipt?.committed??null,queueReason:null,queuedAt:null}];
 }};
 const host={db,apps:{context:async()=>({})},owned:async()=>data,artifacts:{lookup:()=>true,available:()=>true,issueStatusRead:()=>({ref})},localOutput:()=>false};
 const first=await CpuJobs.prototype.status.call(host,peer,'job');
 assert.equal(first.state,'ACCEPTED');assert.equal(first.outputTicket,null,'uncommitted snapshot must not expose a newly committed ticket');
 const final=await CpuJobs.prototype.status.call(host,peer,'job');
 assert.equal(final.state,'SUCCEEDED');assert.deepEqual(final.outputTicket,{ref});
 assert.equal((await CpuJobs.prototype.status.call(host,peer,'job',false)).outputTicket,null);
 await assert.rejects(CpuJobs.prototype.status.call(host,{...peer,principalId:'other'},'job'),/JOB_SCOPE/);
 live.row.metadataJson=JSON.stringify({...data,resultReceivedAt:123});
 assert.equal((await CpuJobs.prototype.status.call(host,peer,'job')).outputTicket,null);
});
