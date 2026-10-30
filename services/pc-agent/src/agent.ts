import { DispatchOfferV2, ExecutionConfigV2, MessageEnvelopeV2, QueuePolicy, ResourceAmountV2, YieldNoticeV2, ExecutorV2, CapabilityAdmissionV2, canonical } from '@harmony/scheduler-core';
import { DurableLedger } from './durable-ledger';
import { RecoveryClient, RecoveryConnection } from './recovery-client';
import { PcExecutionRuntime, ExecutionPorts } from './execution-runtime';
import { DeviceScheduler } from './device-scheduler';
import { TraceBuffer } from './trace-buffer';
import { ExecutionTrace } from './execution-trace';
import { requireBusinessQualification } from './business-gate';

export interface AgentOptions {
  connection:RecoveryConnection;queuePolicy:QueuePolicy;deviceInstanceId:string;
  ports:ExecutionPorts;
  select(offer:DispatchOfferV2):ExecutionConfigV2;
  snapshotVersion(offer:DispatchOfferV2):number|null;
  qualification(offer:DispatchOfferV2):Promise<{executor:ExecutorV2;admission:CapabilityAdmissionV2}>;
  now?:()=>number;
  onYield(notice:YieldNoticeV2):void;
  onError(error:unknown):void;
}
/** Integrated host: authenticated transport -> micro queue -> durable admission -> real CPU -> durable report. */
export class PcAgent {
  readonly client:RecoveryClient;
  readonly scheduler:DeviceScheduler;
  private readonly runtime:PcExecutionRuntime;
  private readonly traces=new TraceBuffer();
  private readonly pending=new Map<string,{message:MessageEnvelopeV2;done:Promise<void>}>();
  private limits:ResourceAmountV2[]=[];private owner:'IDLE'|'ACTIVE'|'UNKNOWN'='UNKNOWN';
  private online=false;private epoch=0;private stopped=false;
  private timer:NodeJS.Timeout|undefined;
  constructor(private readonly ledger:DurableLedger,private readonly options:AgentOptions){
    this.runtime=new PcExecutionRuntime(ledger,{...options.ports,authorize:async offer=>{
      const evidence=await options.qualification(offer);
      const context=await options.ports.authorize(offer);
      requireBusinessQualification(offer,evidence.executor,evidence.admission,ledger.snapshot().holderInstanceId,options.connection.domain,(options.now??Date.now)());
      if(!this.online||this.stopped||this.owner!=='IDLE'||offer.task.coordinatorEpoch!==this.epoch||context.coordinatorEpoch!==this.epoch)throw Error('AGENT_NOT_READY');
      return {...context,online:true,ownerIdle:true,admissionLimit:context.admissionLimit.map(r=>({...r,amount:Math.min(r.amount,this.limits.find(p=>p.resourcePoolId===r.resourcePoolId)?.amount??0)}))};
    }});
    this.scheduler=new DeviceScheduler(ledger,this.runtime,options.queuePolicy,options.onYield);
    this.client=new RecoveryClient(ledger,options.connection,options.onError,{
      state:(ready,epoch)=>{this.online=ready;this.epoch=epoch;
        if(!ready)for(const id of this.pending.keys())this.scheduler.cancel(id);
        void this.scheduler.update(ready?this.limits:[],ready?this.owner:'UNKNOWN').catch(options.onError);
      },dispatch:message=>this.dispatch(message)
    });
  }
  get ready(){return this.online&&!this.stopped;}
  async updateResources(limits:ResourceAmountV2[],owner:'IDLE'|'ACTIVE'|'UNKNOWN'){
    this.limits=structuredClone(limits);this.owner=owner;
    await this.scheduler.update(this.online?limits:[],this.online?owner:'UNKNOWN');
  }
  private dispatch(message:MessageEnvelopeV2){
    if(this.stopped)return;
    const offer=JSON.parse(message.payload) as DispatchOfferV2,id=offer.task.attemptId,previous=this.pending.get(id);
    if(previous){if(canonical(previous.message)!==canonical(message))throw Error('INFLIGHT_DISPATCH_CONFLICT');return;}
    if(this.pending.size>=8){this.ledger.rejectDispatch(message,'AGENT_BACKPRESSURE');void this.client.flush();return;}
    const done=(async()=>{
      try{
        if(offer.target.backend!=='CPU'||offer.task.contract.interruptibility!=='CANCEL_RESTART')throw Error('EXECUTOR_UNSUPPORTED');
        const version=this.options.snapshotVersion(offer);
        const trace=version===null?undefined:new ExecutionTrace(this.traces,{traceId:message.traceId,parentSpanId:null,snapshotVersion:version,deviceInstanceId:this.options.deviceInstanceId},offer);
        await this.scheduler.submit(offer,this.options.select(offer),{message,trace,admitted:()=>{void this.client.flush();}});
      }catch(error){
        if(!this.ledger.status(id)){
          const reason=error instanceof Error&&/^[A-Z_]{1,100}$/.test(error.message)?error.message:'EXECUTION_REJECTED';
          try{this.ledger.rejectDispatch(message,reason);}catch(rejection){this.options.onError(rejection);}
        }else this.options.onError(error);
      }finally{await this.flush();}
    })();
    this.pending.set(id,{message:structuredClone(message),done});void done.finally(()=>this.pending.delete(id)).catch(this.options.onError);
  }
  async flush(){
    if(!this.stopped)await this.traces.flush(async spans=>{this.ledger.queueTrace(spans);});
    await this.client.flush();
  }
  start(){
    if(this.timer||this.stopped)throw Error('AGENT_ALREADY_STARTED');this.client.start();
    this.timer=setInterval(()=>{void this.flush().catch(this.options.onError);},250);this.timer.unref();
  }
  async close(){
    if(this.stopped)return;this.stopped=true;if(this.timer)clearInterval(this.timer);
    await this.client.close();await this.scheduler.close();await Promise.allSettled([...this.pending.values()].map(p=>p.done));
  }
}
