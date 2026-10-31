import { createHash } from 'node:crypto';
import { DispatchOfferV2, ExecutionReceiptV2, ExecutionConfigV2, LedgerAdmissionV2, ArtifactRefV2, MessageEnvelopeV2, canonical } from '@harmony/scheduler-core';
import { DurableLedger } from './durable-ledger';
import { executeCpu } from './cpu-engine';
import { ExecutionTrace } from './execution-trace';

export interface ExecutionPorts {
  /** Trusted local gate checks current qualification, target identity, task authorization and owner policy. */
  authorize(offer:DispatchOfferV2):Promise<Omit<LedgerAdmissionV2,'now'|'executionDigest'|'leaseId'>>;
  read(ref:ArtifactRefV2,offer:DispatchOfferV2):Promise<Buffer>;
  publish(bytes:Buffer,schemaId:string,offer:DispatchOfferV2):Promise<ArtifactRefV2>;
}
export class PcExecutionRuntime {
  private readonly active=new Map<string,{abort:AbortController;done:Promise<ExecutionReceiptV2>}>();
  constructor(private readonly ledger:DurableLedger,private readonly ports:ExecutionPorts,private readonly delivery:'BUSINESS'|'EVALUATION'='BUSINESS'){}
  async run(offer:DispatchOfferV2,selected:ExecutionConfigV2,hooks:{selected?:()=>void;admitted?:()=>void;trace?:ExecutionTrace;maxDurationMs?:number;message?:MessageEnvelopeV2}={}):Promise<ExecutionReceiptV2>{
    if(offer.target.backend!=='CPU'||offer.task.contract.sideEffectPolicy!=='PURE'||offer.task.inputs.length!==1||!offer.allowedConfigs.some(c=>canonical(c)===canonical(selected)))throw Error('EXECUTION_UNSUPPORTED');
    const admit=async()=>{const context=await this.ports.authorize(offer);return this.ledger.admit(offer,context,hooks.message);};
    const entry=hooks.trace?await hooks.trace.segment('ADMIT',admit):await admit(),id=entry.record.attemptId;
    if(entry.record.receipt)return entry.record.receipt;
    if(this.active.has(id))return this.active.get(id)!.done;
    if(entry.record.state!=='ACCEPTED')throw Error('EXECUTION_RECOVERY_REQUIRED');
    hooks.admitted?.();
    const abort=new AbortController();
    const done=this.execute(offer,selected,entry.record.fence,abort,hooks.trace,hooks.maxDurationMs);
    this.active.set(id,{abort,done});try{return await done;}finally{this.active.delete(id);}
  }
  private async execute(offer:DispatchOfferV2,config:ExecutionConfigV2,fence:ExecutionReceiptV2['fence'],abort:AbortController,trace?:ExecutionTrace,maxDurationMs=Infinity){
    const task=offer.task;let state='FAILED',outputs:ArtifactRefV2[]=[],errorCode:string|null=null;
    const segment=<T>(phase:string,work:()=>Promise<T>)=>trace?trace.segment(phase,work):work();
    const deadline=setTimeout(()=>abort.abort(),Math.min(offer.leaseMs,task.budget.remainingMs,maxDurationMs));
    try{
      const bytes=await segment('LOAD',()=>this.ports.read(task.inputs[0],offer));
      if(createHash('sha256').update(bytes).digest('hex')!==task.inputs[0].contentHash)throw Error('INPUT_HASH');
      if(abort.signal.aborted)throw Error('CANCELLED_SETTLED');
      this.ledger.begin(task.attemptId); // Durable RUNNING always precedes the engine call.
      const result=await segment('EXECUTE',()=>executeCpu(task.contract.capability,bytes,JSON.parse(task.parameters),config,abort.signal));
      if(abort.signal.aborted)throw Error('CANCELLED_SETTLED');
      const ref=await segment('PUBLISH',()=>this.ports.publish(result.bytes,result.schemaId,offer));
      if(abort.signal.aborted)throw Error('CANCELLED_SETTLED');
      if(ref.contentHash!==result.hash||!task.contract.outputSchemas.includes(ref.schemaId))throw Error('OUTPUT_SCOPE');outputs=[ref];state='SUCCEEDED';
    }catch(error){errorCode=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'EXECUTION_FAILED';if(abort.signal.aborted||errorCode==='CANCELLED_SETTLED')state='CANCELLED_SETTLED';}
    finally{clearTimeout(deadline);}
    const receipt:ExecutionReceiptV2={attemptId:task.attemptId,coordinatorEpoch:task.coordinatorEpoch,planRevision:task.planRevision,fence,state,resourcesSettled:true,outputs,
      actualTarget:offer.target,actualConfiguration:config.id,errorCode};this.ledger.settle(receipt,this.delivery);return receipt;
  }
  cancel(attemptId:string){this.ledger.cancel(attemptId);this.active.get(attemptId)?.abort.abort();}
  async close(){for(const [id]of this.active)this.cancel(id);await Promise.allSettled([...this.active.values()].map(a=>a.done));}
}
