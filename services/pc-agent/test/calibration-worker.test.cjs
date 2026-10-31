const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {CalibrationWorker}=require('../dist/calibration-worker');
const {decodeEvaluationReport,validEvaluationWork}=require('@harmony/resource-transport');
const {canonical}=require('@harmony/scheduler-core');
function work(){
 const executor=structuredClone(require('../../../contracts/scheduling/v2/fixtures/t2/valid/DeviceProfile.json').executors[0]);
 const permit={id:crypto.randomUUID(),groupId:'g1',holderInstanceId:'h1',targetId:'target1',identity:crypto.createHash('sha256').update(canonical({target:executor.target,contract:executor.contract,model:executor.model,resources:executor.resources,configurations:executor.configurations})).digest('hex'),
  packDigest:'a'.repeat(64),caseId:'case1',inputHash:'b'.repeat(64),config:executor.configurations[0],maxOutputBytes:65536,timeoutMs:5000,domain:'SIMULATED'};
 return {permit,executor,coordinatorEpoch:1,ledgerEpoch:1,deviceInstanceId:'instance1',expiresAt:Date.now()+5000,mode:'RUN'};
}
const ledger={snapshot:()=>({groupId:'g1',holderInstanceId:'h1',deviceId:'device1',ledgerEpoch:1}),status:()=>null};
const options={domain:'SIMULATED',deviceInstanceId:'instance1',ready:()=>true,authorize:async()=>true,onError:()=>{}};
test('uncertain delivery reconciles only; mismatched holder cannot reach the executor',async()=>{
 let runs=0,reconciles=0;const w=work();w.mode='RECONCILE';
 const executor={reconcile:async()=>{reconciles++;return null;},runInstalled:async()=>{runs++;}};
 const worker=new CalibrationWorker(ledger,executor,async()=>({work:w}),options);
 await worker.tick();assert.equal(runs,0);assert.equal(reconciles,1);
 w.permit.holderInstanceId='other';await assert.rejects(worker.tick(),/SCOPE/);assert.equal(reconciles,1);await worker.close();
});
test('worker serializes ticks and shutdown cancels an active engine before returning',async()=>{
 const w=work();let started,stopped=false,reported=false;const start=new Promise(resolve=>started=resolve);
 const executor={reconcile:async()=>null,runInstalled:async(p,_e,signal)=>{
  started();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));stopped=true;
  return {settled:true,permitId:p.id,domain:p.domain,output:Buffer.alloc(0),durationMs:0};
 }};
 const request=async route=>{if(route.endsWith('/claim'))return {work:w};if(route.endsWith('/report')){assert.equal(stopped,true);reported=true;return {acknowledged:true};}return {cancel:false,settled:false};};
 const worker=new CalibrationWorker(ledger,executor,request,options),tick=worker.tick();assert.equal(worker.tick(),tick);
 await start;await worker.close();assert.equal(stopped,true);assert.equal(reported,true);await tick;
});
test('owner change cancels an active calibration; stale installation never starts',async()=>{
 const w=work();let owner=true,runs=0;
 const executor={reconcile:async()=>null,runInstalled:async(p,_e,signal)=>{runs++;owner=false;
  await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
  return {settled:true,permitId:p.id,domain:p.domain,output:Buffer.alloc(0),durationMs:0};}};
 const request=async route=>route.endsWith('/claim')?{work:w}:route.endsWith('/report')?{acknowledged:true}:{cancel:false,settled:false};
 const worker=new CalibrationWorker(ledger,executor,request,{...options,authorize:async()=>owner});
 await worker.tick();assert.equal(runs,1);owner=true;w.ledgerEpoch=2;await worker.tick();assert.equal(runs,1);await worker.close();
});
test('reference output wire format enforces exact scope and canonical bounded base64',()=>{
 const w=work(),report={settled:true,permitId:w.permit.id,domain:'SIMULATED',durationMs:1,output:Buffer.alloc(65536).toString('base64')};
 assert.equal(validEvaluationWork(w),true);assert.equal(decodeEvaluationReport(report,w.permit).output.length,65536);
 for(const mutation of [{output:Buffer.alloc(65537).toString('base64')},{domain:'REAL'},{durationMs:-1},{output:'AA'},{extra:true}])assert.throws(()=>decodeEvaluationReport({...report,...mutation},w.permit),/INVALID/);
});
test('idle calibration worker does not poll; a new event wakes it exactly once',async()=>{
 let requests=0;const worker=new CalibrationWorker(ledger,{reconcile:async()=>null},async()=>{requests++;return {work:null};},options);
 worker.start(100);await new Promise(r=>setTimeout(r,350));assert.equal(requests,1);
 worker.notify();await new Promise(r=>setTimeout(r,20));assert.equal(requests,2);await worker.close();
});

test('a RUN rejected before admission persists non-execution and retries its report without rerunning',async()=>{
 const w=work();let declined=null,runs=0,reports=0;
 const executor={reconcile:async()=>declined,decline:async p=>(declined={settled:true,permitId:p.id,domain:p.domain,output:Buffer.alloc(0),durationMs:0}),runInstalled:async()=>{runs++;throw Error('HOST_NOT_AVAILABLE');}};
 const request=async route=>{if(route.endsWith('/claim'))return {work:w};if(route.endsWith('/report')){if(++reports===1)throw Error('LOST_REPORT');return {acknowledged:true};}return {cancel:false,settled:false};};
 const worker=new CalibrationWorker(ledger,executor,request,options);
 await assert.rejects(worker.tick(),/LOST_REPORT/);w.mode='RECONCILE';await worker.tick();assert.equal(runs,1);assert.equal(reports,2);await worker.close();
});

test('declined evaluation survives executor recreation and cannot be confused with admitted execution',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {CalibrationExecutor}=require('../dist/calibration-executor');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-declined-')),w=work();let admitted=false;
 const local={...ledger,status:()=>admitted?{resourcesSettled:false}:null};
 try{
  const make=()=>new CalibrationExecutor(local,dir,'SIMULATED',new Map(),async()=>{throw Error('MUST_NOT_RUN');},async()=>{throw Error('MUST_NOT_RUN');});
  await make().decline(w.permit);assert.equal((await make().reconcile(w.permit)).output.length,0);
  assert.equal((await make().runInstalled(w.permit,w.executor,new AbortController().signal)).settled,true);
  await assert.rejects(make().reconcile({...w.permit,caseId:'changed'}),/CONFLICT/);
  admitted=true;await assert.rejects(make().decline(w.permit),/INVALID/);await assert.rejects(make().reconcile(w.permit),/CONFLICT/);
 }finally{if(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'harmony-declined-'))fs.rmSync(dir,{recursive:true,force:true});}
});
