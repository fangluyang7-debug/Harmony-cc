// Isolated test host: receives private configuration through IPC, never logs it.
const path=require('node:path');
const {DurableLedger}=require('../../pc-agent/dist/durable-ledger');
const {CalibrationExecutor}=require('../../pc-agent/dist/calibration-executor');
const {CalibrationWorker}=require('../../pc-agent/dist/calibration-worker');
const {AllotmentClient,allotmentTransport}=require('../../pc-agent/dist/allotment-client');
const {RecoveryClient}=require('../../pc-agent/dist/recovery-client');
let worker,ledger,client,runs=0,dropped=false,online=false;
process.on('message',async message=>{
 try{
  if(message.stop){await worker?.close();await client?.close();await ledger?.close();process.disconnect();return;}
  const c=message.config,request=allotmentTransport(c.connection);
  ledger=await DurableLedger.open(c.directory,c.identity,c.connection.certificate);
  const quota=new AllotmentClient(ledger,c.connection.credential,request,()=>({base:[],extra:c.executor.resources,leaseMs:300000}),()=>{});
  await quota.renew();await quota.close();
  const test={...c.test,input:Buffer.from(c.test.input,'base64')};
  const evaluator=new CalibrationExecutor(ledger,path.join(c.directory,'results'),c.connection.domain,new Map([[c.packDigest+':'+test.id,test]]),async permit=>{
   const offer=structuredClone(c.offer);offer.task.attemptId=permit.id;offer.task.workflowId='evaluation-'+permit.id;offer.task.nodeId='case-'+permit.id;
   offer.allotmentId=ledger.snapshot().grant.allotmentId;offer.leaseMs=permit.timeoutMs;offer.task.budget={remainingMs:permit.timeoutMs,deadlineAt:Date.now()+permit.timeoutMs};return offer;
  },async()=>({coordinatorEpoch:c.epoch,online:true,ownerIdle:true,admissionLimit:c.executor.resources}));
  const run=evaluator.runInstalled.bind(evaluator);evaluator.runInstalled=async(...args)=>{runs++;process.send({runs});return run(...args);};
  worker=new CalibrationWorker(ledger,evaluator,async(route,body)=>{
   if(c.dropReport&&!dropped&&route.endsWith('/report')){dropped=true;throw Error('TEST_REPORT_DELIVERY_LOST');}
   return request(route,body);
  },{domain:c.connection.domain,deviceInstanceId:c.instance,ready:()=>online,authorize:async w=>w.coordinatorEpoch===c.epoch,onError:()=>{}});
  client=new RecoveryClient(ledger,c.connection,()=>{},{dispatch:()=>{},state:ready=>{online=ready;if(ready)worker.notify();},evaluationChanged:()=>worker.notify()});
  worker.start(100);client.start();process.send({ready:true});
 }catch{process.send?.({failed:true});await worker?.close();await client?.close();await ledger?.close();process.disconnect();process.exitCode=1;}
});
