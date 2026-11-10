// Read-only audit of measured SDK jobs, using an explicitly supplied local DB.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {PrismaClient}=require('../services/coordinator/generated/client');
const median=values=>{const v=values.slice().sort((a,b)=>a-b);return v.length%2?v[(v.length-1)/2]:(v[v.length/2-1]+v[v.length/2])/2;};
async function main(){
 const [file,database]=process.argv.slice(2);if(!file||!database)throw Error('REPORT_AND_DATABASE_REQUIRED');
 const report=JSON.parse(fs.readFileSync(file)),db=new PrismaClient({datasources:{db:{url:'file:'+path.resolve(database).replaceAll('\\','/')}}});
 try{
  const rows=[],timings={},artifacts=new Set();
  for(const run of report.runs){
   assert.equal(run.state,'SUCCEEDED');assert.equal(run.uploadedBytes,run.expectedUploadBytes);
   assert.deepEqual(run.transfers.map(t=>t.contentHash).sort(),run.jobs.map(j=>j.inputHash).sort());
   for(const transfer of run.transfers){assert.ok(transfer.afterStartMs>0);assert.ok(!artifacts.has(transfer.artifactId));artifacts.add(transfer.artifactId);}
   for(const job of run.jobs){
    const stored=await db.cpuJob.findUniqueOrThrow({where:{id:job.id}}),meta=JSON.parse(stored.metadataJson),attempts=await db.attempt.findMany({where:{workflowId:job.id}}),receipt=await db.receipt.findUniqueOrThrow({where:{id:job.id}});
    assert.equal(attempts.length,1);assert.equal(attempts[0].state,'SUCCEEDED');assert.equal(JSON.parse(attempts[0].recordJson).resourcesSettled,true);assert.equal(receipt.committed,true);assert.ok(meta.resultReceivedAt);assert.equal(meta.offer.target.targetId,job.targetId);
    const traces=await db.$queryRaw`SELECT metadataJson FROM TraceSpan WHERE groupId=${stored.groupId} AND json_extract(metadataJson,'$.span.traceId')=${meta.traceId}`;
    const spans=traces.map(t=>JSON.parse(t.metadataJson).span);assert.ok(spans.some(t=>t.phase==='EXECUTE'));assert.ok(spans.some(t=>t.phase==='TRANSFER_RECV'),'fresh input transfer must be observed');
    for(const span of spans)if(['LOAD','EXECUTE','PUBLISH','PLAN','OFFER'].includes(span.phase)&&span.reasonCode!=='LOCAL_PHASE_UNCLASSIFIED'){
     const key=run.mode+'/'+job.deviceId+'/'+span.phase;(timings[key]??=[]).push(span.durationMs);
    }
    rows.push({jobId:job.id,mode:run.mode,deviceId:job.deviceId,uniqueAttempt:true,committed:true,settled:true,received:true,traceId:meta.traceId,spans:spans.map(s=>({phase:s.phase,ms:s.durationMs,reason:s.reasonCode}))});
   }
  }
  assert.equal(new Set(report.runs.map(r=>r.sourceHash)).size,1);assert.equal(new Set(report.runs.map(r=>r.normalizedHash)).size,1);assert.equal(new Set(report.runs.map(r=>r.resultHash)).size,1);
  const batchHash=run=>JSON.stringify(run.jobs.slice().sort((a,b)=>a.index-b.index).map(j=>j.inputHash));assert.equal(new Set(report.runs.map(batchHash)).size,1);
  const summary={checkedAt:new Date().toISOString(),allPassed:true,jobs:rows.length,freshInputArtifacts:artifacts.size,resultHash:report.runs[0].resultHash,modes:Object.fromEntries([...new Set(report.runs.map(r=>r.mode))].map(mode=>{const runs=report.runs.filter(r=>r.mode===mode);return [mode,{count:runs.length,medianMs:median(runs.map(r=>r.durationMs)),minMs:Math.min(...runs.map(r=>r.durationMs)),maxMs:Math.max(...runs.map(r=>r.durationMs)),everyRunUsesBothDevices:runs.every(r=>r.actualDevices.length===2)}];})),phases:Object.fromEntries(Object.entries(timings).map(([k,v])=>[k,{count:v.length,medianMs:median(v),maxMs:Math.max(...v)}])),rows};
  fs.writeFileSync(file.replace(/\.json$/,'-audit.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({allPassed:true,jobs:rows.length,modes:summary.modes,phases:summary.phases}));
 }finally{await db.$disconnect();}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={median};
