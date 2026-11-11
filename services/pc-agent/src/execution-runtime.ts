import {BackendRegistry} from './executors/backend-registry';
import type {ImageEncoder} from './image-encoder';
import {ModelManifestV2} from '@harmony/scheduler-core';
import { createHash } from 'node:crypto';
import { DispatchOfferV2, ExecutionReceiptV2, ExecutionConfigV2, LedgerEntryV2, LedgerAdmissionV2, ArtifactRefV2, MessageEnvelopeV2, canonical } from '@harmony/scheduler-core';
import { DurableLedger } from './durable-ledger';
import { ExecutionTrace } from './execution-trace';

export interface ExecutionPorts {
  imageEncoder?:ImageEncoder;
  measuredExecution?(wallMs:number,overheadMs?:number):void;
  service?(offer:DispatchOfferV2,input:Buffer,signal:AbortSignal):Promise<{bytes:Buffer;schemaId:string}>;
  /** Trusted local gate checks current qualification, target identity, task authorization and owner policy. */
  authorize(offer:DispatchOfferV2):Promise<Omit<LedgerAdmissionV2,'now'|'executionDigest'|'leaseId'>>;
  read(ref:ArtifactRefV2,offer:DispatchOfferV2,trace?:ExecutionTrace):Promise<Buffer>;
  publish(bytes:Buffer,schemaId:string,offer:DispatchOfferV2,trace?:ExecutionTrace):Promise<ArtifactRefV2>;
}
export class PcExecutionRuntime {
  private readonly active=new Map<string,{abort:AbortController;done:Promise<ExecutionReceiptV2>}>();
  private readonly engines:BackendRegistry;
  constructor(private readonly ledger:DurableLedger,private readonly ports:ExecutionPorts,private readonly delivery:'BUSINESS'|'EVALUATION'='BUSINESS'){this.engines=new BackendRegistry(ports.imageEncoder,ports.service);}
  async run(offer:DispatchOfferV2,selected:ExecutionConfigV2,hooks:{waiting?:(reason:string,pools:string[],entries:LedgerEntryV2[])=>void;selected?:(entries:LedgerEntryV2[])=>void;admitted?:()=>void;trace?:ExecutionTrace;maxDurationMs?:number;message?:MessageEnvelopeV2}={}):Promise<ExecutionReceiptV2>{
    if((offer.target.backend!=='CPU'&&!(['CUDA','VULKAN'].includes(offer.target.backend)&&this.ports.imageEncoder?.gpu)&&!(offer.target.backend==='SERVICE'&&offer.task.contract.serviceId&&this.ports.service))||!(offer.task.contract.sideEffectPolicy==='PURE'||offer.task.contract.sideEffectPolicy==='IDEMPOTENT_WRITE'&&offer.target.backend==='SERVICE'&&offer.task.businessIdempotencyKey!==null)||offer.task.inputs.length!==1||!offer.allowedConfigs.some(c=>canonical(c)===canonical(selected)))throw Error('EXECUTION_UNSUPPORTED');
    const admit=async()=>{const context=await this.ports.authorize(offer);return this.ledger.admit(offer,context,hooks.message);};
    const entry=hooks.trace?await hooks.trace.segment('ADMIT',admit):await admit(),id=entry.record.attemptId;
    if(entry.record.receipt)return entry.record.receipt;
    if(this.active.has(id))return this.active.get(id)!.done;
    if(entry.record.state!=='ACCEPTED')throw Error('EXECUTION_RECOVERY_REQUIRED');
    const abort=new AbortController();
    const done=Promise.resolve().then(()=>this.execute(offer,selected,entry.record.fence,abort,hooks.trace,hooks.maxDurationMs));
    this.active.set(id,{abort,done});
    try{hooks.admitted?.();}catch{abort.abort();}
    try{return await done;}finally{this.active.delete(id);}
  }
  private async execute(offer:DispatchOfferV2,config:ExecutionConfigV2,fence:ExecutionReceiptV2['fence'],abort:AbortController,trace?:ExecutionTrace,maxDurationMs=Infinity){
    let overheadMs:number|undefined;
    let actualModel:ModelManifestV2|null=null;
    const task=offer.task;let state='FAILED',outputs:ArtifactRefV2[]=[],errorCode:string|null=null;
    const segment=<T>(phase:string,work:()=>Promise<T>)=>trace?trace.segment(phase,work):work();
    const deadline=setTimeout(()=>abort.abort(),Math.min(offer.leaseMs,task.budget.remainingMs,maxDurationMs));
    try{
      if(abort.signal.aborted)throw Error('CANCELLED_SETTLED');
      const bytes=await segment('LOAD',async()=>{
        const input=await this.ports.read(task.inputs[0],offer,trace);
        if(createHash('sha256').update(input).digest('hex')!==task.inputs[0].contentHash)throw Error('INPUT_HASH');
        return input;
      });
      if(abort.signal.aborted)throw Error('CANCELLED_SETTLED');
      this.ledger.begin(task.attemptId,bytes.length,task.contract.serviceId||task.contract.capability.startsWith('photo.')?'UNKNOWN':'COLD'); // Durable RUNNING always precedes the engine call.
      const execute=()=>this.engines.run(offer,bytes,config,abort.signal);
      const started=performance.now();let wallMs:number|undefined;
      const result=trace?await trace.segment('EXECUTE',execute,ms=>{wallMs=ms;}):await execute();
      actualModel=result.model??null;
      wallMs??=performance.now()-started;
      if(!task.contract.capability.startsWith('photo.')&&'durationMs' in result&&typeof result.durationMs==='number'&&result.durationMs>=0&&result.durationMs<=wallMs)overheadMs=wallMs-result.durationMs;
      this.ports.measuredExecution?.(wallMs,overheadMs);
      if(abort.signal.aborted)throw Error('CANCELLED_SETTLED');
      const ref=await segment('PUBLISH',async()=>{
        const output=await this.ports.publish(result.bytes,result.schemaId,offer,trace);
        if(output.contentHash!==result.hash||!task.contract.outputSchemas.includes(output.schemaId))throw Error('OUTPUT_SCOPE');
        return output;
      });
      if(abort.signal.aborted)throw Error('CANCELLED_SETTLED');
      outputs=[ref];state='SUCCEEDED';
    }catch(error){errorCode=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'EXECUTION_FAILED';if(abort.signal.aborted||errorCode==='CANCELLED_SETTLED')state='CANCELLED_SETTLED';}
    finally{clearTimeout(deadline);}
    const receipt:ExecutionReceiptV2={attemptId:task.attemptId,coordinatorEpoch:task.coordinatorEpoch,planRevision:task.planRevision,fence,state,resourcesSettled:true,outputs,
      actualTarget:offer.target,actualConfiguration:config.id,errorCode};this.ledger.settle(receipt,this.delivery,actualModel,overheadMs);return receipt;
  }
  cancel(attemptId:string){this.ledger.cancel(attemptId);this.active.get(attemptId)?.abort.abort();}
  async close(){for(const [id]of this.active)this.cancel(id);await Promise.allSettled([...this.active.values()].map(a=>a.done));}
}
