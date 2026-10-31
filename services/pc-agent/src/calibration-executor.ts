import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DispatchOfferV2, ExecutionConfigV2, ExecutorV2, canonical } from '@harmony/scheduler-core';
import { DurableLedger } from './durable-ledger';
import { ExecutionPorts, PcExecutionRuntime } from './execution-runtime';
import type { EvaluationPermit as Permit, EvaluationResult as Result } from '@harmony/resource-transport';

interface EvaluationCase {id:string;input:Buffer;parameters:string;config:ExecutionConfigV2;maxOutputBytes:number;}
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
/** Local trusted calibration path; never accepts ordinary business offers. Uses the SAME durable quota ledger as business execution. */
export class CalibrationExecutor {
  constructor(private readonly ledger:DurableLedger,private readonly directory:string,private readonly domain:'REAL'|'SIMULATED',
    private readonly installed:ReadonlyMap<string,EvaluationCase>,
    private readonly offerFor:(permit:Permit,executor:ExecutorV2)=>Promise<DispatchOfferV2>,private readonly authorize:ExecutionPorts['authorize']){
    fs.mkdirSync(directory,{recursive:true});
  }
  private filename(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw Error('PERMIT_INVALID');return path.join(this.directory,id+'.json');}
  /** A RUN delivery rejected before durable admission proves no engine started in this installation. */
  async decline(permit:Permit):Promise<Result>{
    const state=this.ledger.snapshot();
    if(permit.domain!==this.domain||permit.groupId!==state.groupId||permit.holderInstanceId!==state.holderInstanceId||this.ledger.status(permit.id))throw Error('EVALUATION_DECLINE_INVALID');
    const filename=this.filename(permit.id)+'.declined',text=canonical(permit);
    if(fs.existsSync(filename)){if(fs.readFileSync(filename,'utf8')!==text)throw Error('EVALUATION_DECLINE_CONFLICT');}
    else{const temporary=filename+'.tmp',fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,filename);}
    return {settled:true,permitId:permit.id,domain:this.domain,output:Buffer.alloc(0),durationMs:0};
  }
  async runInstalled(permit:Permit,executor:ExecutorV2,signal:AbortSignal):Promise<Result>{
    if(fs.existsSync(this.filename(permit.id)+'.declined'))return (await this.reconcile(permit))!;
    const test=this.installed.get(permit.packDigest+':'+permit.caseId);if(!test)throw Error('TRUSTED_PACK_REQUIRED');
    return this.run(permit,test,executor,signal);
  }
  async run(permit:Permit,test:EvaluationCase,executor:ExecutorV2,signal:AbortSignal):Promise<Result>{
    const installed=this.installed.get(permit.packDigest+':'+permit.caseId),state=this.ledger.snapshot();
    const identity=hash(Buffer.from(canonical({target:executor.target,contract:executor.contract,model:executor.model,resources:executor.resources,configurations:executor.configurations})));
    if(!installed||signal.aborted||permit.domain!==this.domain||permit.groupId!==state.groupId||permit.holderInstanceId!==state.holderInstanceId||permit.targetId!==executor.target.targetId||
      permit.identity!==identity||permit.inputHash!==hash(installed.input)||hash(test.input)!==permit.inputHash||canonical(test.config)!==canonical(installed.config)||
      canonical(permit.config)!==canonical(installed.config)||test.parameters!==installed.parameters||permit.maxOutputBytes!==installed.maxOutputBytes||permit.timeoutMs<=0||permit.timeoutMs>300000)throw Error('EVALUATION_UNAUTHORIZED');
    const filename=this.filename(permit.id),offer=await this.offerFor(permit,executor);
    if(offer.task.attemptId!==permit.id||offer.task.groupId!==permit.groupId||canonical(offer.target)!==canonical(executor.target)||canonical(offer.task.contract)!==canonical(executor.contract)||
      canonical(offer.resources)!==canonical(executor.resources)||offer.task.inputs.length!==1||offer.task.inputs[0].contentHash!==permit.inputHash||
      offer.task.parameters!==installed.parameters||canonical(offer.allowedConfigs)!==canonical([permit.config])||offer.leaseMs>permit.timeoutMs)throw Error('EVALUATION_OFFER_SCOPE');
    const start=performance.now();
    const runtime=new PcExecutionRuntime(this.ledger,{authorize:this.authorize,read:async()=>Buffer.from(installed.input),publish:async(output,schemaId)=>{
      if(output.length>permit.maxOutputBytes)throw Error('EVALUATION_OUTPUT_LIMIT');
      const report={permitId:permit.id,domain:this.domain,durationMs:performance.now()-start,output:output.toString('base64'),hash:hash(output)};
      const temporary=filename+'.tmp',fd=fs.openSync(temporary,'wx',0o600);
      try{fs.writeFileSync(fd,JSON.stringify(report));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,filename);
      return {artifactId:permit.id,contentVersion:1,contentHash:report.hash,schemaId,schemaVersion:1};
    }});
    let admitted=false;
    const cancel=()=>{if(admitted)runtime.cancel(permit.id);};signal.addEventListener('abort',cancel,{once:true});
    try{
      await runtime.run(offer,permit.config,{maxDurationMs:permit.timeoutMs,admitted:()=>{admitted=true;if(signal.aborted)queueMicrotask(cancel);}});
      if(signal.aborted)cancel();
      const result=await this.reconcile(permit);if(!result)throw Error('EVALUATION_SETTLEMENT_UNKNOWN');return result;
    }finally{signal.removeEventListener('abort',cancel);await runtime.close();}
  }
  async reconcile(permit:Permit):Promise<Result|null>{
    const declined=this.filename(permit.id)+'.declined';
    if(fs.existsSync(declined)){
      if(fs.readFileSync(declined,'utf8')!==canonical(permit)||this.ledger.status(permit.id))throw Error('EVALUATION_DECLINE_CONFLICT');
      return {settled:true,permitId:permit.id,domain:this.domain,output:Buffer.alloc(0),durationMs:0};
    }
    const record=this.ledger.status(permit.id);if(!record?.resourcesSettled||permit.domain!==this.domain||record.groupId!==permit.groupId||record.holderInstanceId!==permit.holderInstanceId||record.receipt?.actualTarget.targetId!==permit.targetId)return null;
    if(record.receipt?.state!=='SUCCEEDED')return {settled:true,permitId:permit.id,domain:this.domain,output:Buffer.alloc(0),durationMs:0};
    try{
      const saved=JSON.parse(fs.readFileSync(this.filename(permit.id),'utf8')),output=Buffer.from(saved.output,'base64');
      if(saved.permitId!==permit.id||saved.domain!==this.domain||output.length>permit.maxOutputBytes||hash(output)!==saved.hash||!record.receipt.outputs.some(r=>r.contentHash===saved.hash)||!Number.isFinite(saved.durationMs)||saved.durationMs<0)return null;
      return {settled:true,permitId:permit.id,domain:this.domain,output,durationMs:saved.durationMs};
    }catch{return null;}
  }
}
