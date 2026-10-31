import { DispatchOfferV2, ExecutionConfigV2, MessageEnvelopeV2, QueuePolicy, ResourceAmountV2, YieldNoticeV2, ExecutorV2, CapabilityAdmissionV2, canonical } from '@harmony/scheduler-core';
import { DurableLedger } from './durable-ledger';
import { RecoveryClient, RecoveryConnection } from './recovery-client';
import { PcExecutionRuntime, ExecutionPorts } from './execution-runtime';
import { DeviceScheduler } from './device-scheduler';
import { TraceBuffer } from './trace-buffer';
import { ExecutionTrace } from './execution-trace';
import { requireBusinessQualification } from './business-gate';
import { AllotmentClient, AllotmentPolicy, allotmentTransport } from './allotment-client';
import { DeviceProfileV2, occupiedV2 } from '@harmony/scheduler-core';
import { ResourceMonitor, ResourceMonitorPolicy, collectSystemResources } from './system-resources';
import { CalibrationExecutor } from './calibration-executor';
import { CalibrationWorker } from './calibration-worker';

export interface AgentOptions {
  connection:RecoveryConnection;queuePolicy:QueuePolicy;deviceInstanceId:string;
  ports:ExecutionPorts;
  select(offer:DispatchOfferV2):ExecutionConfigV2;
  snapshotVersion(offer:DispatchOfferV2):number|null|Promise<number|null>;
  qualification?(offer:DispatchOfferV2):Promise<{executor:ExecutorV2;admission:CapabilityAdmissionV2}>;
  now?:()=>number;
  onYield(notice:YieldNoticeV2):void;
  onError(error:unknown):void;
  onExecutionSettled?():void;
  allotments?:{policy:()=>AllotmentPolicy;renewEveryMs:number};
  resources?:{policy:ResourceMonitorPolicy;owner:()=>Promise<'IDLE'|'ACTIVE'|'UNKNOWN'>};
  calibration?:{executor:CalibrationExecutor;intervalMs?:number};
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
  private readonly allotments:AllotmentClient|undefined;
  private readonly resourceMonitor:ResourceMonitor|undefined;
  private readonly calibration:CalibrationWorker|undefined;
  private readonly profileWaiters=new Map<string,{resolve:()=>void;reject:(e:Error)=>void}>();
  constructor(private readonly ledger:DurableLedger,private readonly options:AgentOptions){
    if(options.allotments){
      const interval=options.allotments.renewEveryMs;
      if(!Number.isSafeInteger(interval)||interval<100)throw Error('ALLOTMENT_INTERVAL_INVALID');
      this.allotments=new AllotmentClient(ledger,options.connection.credential,allotmentTransport(options.connection),()=>{
        const policy=options.allotments!.policy();
        if(policy.leaseMs<=interval)throw Error('ALLOTMENT_RENEWAL_TOO_LATE');
        return policy;
      },options.onError);
    }
    this.runtime=new PcExecutionRuntime(ledger,{...options.ports,authorize:async offer=>{
      const evidence=options.qualification?await options.qualification(offer):
        await allotmentTransport(options.connection)('/v2/qualification/'+offer.target.targetId,null) as {executor:ExecutorV2;admission:CapabilityAdmissionV2};
      const context=await options.ports.authorize(offer);
      requireBusinessQualification(offer,evidence.executor,evidence.admission,ledger.snapshot().holderInstanceId,options.connection.domain,(options.now??Date.now)());
      if(!this.online||this.stopped||this.owner!=='IDLE'||offer.task.coordinatorEpoch!==this.epoch||context.coordinatorEpoch!==this.epoch)throw Error('AGENT_NOT_READY');
      return {...context,online:true,ownerIdle:true,admissionLimit:context.admissionLimit.map(r=>({...r,amount:Math.min(r.amount,this.limits.find(p=>p.resourcePoolId===r.resourcePoolId)?.amount??0)}))};
    }});
    this.scheduler=new DeviceScheduler(ledger,this.runtime,options.queuePolicy,options.onYield);
    if(options.resources)this.resourceMonitor=new ResourceMonitor(options.resources.policy,{
      sample:async()=>collectSystemResources(),owner:options.resources.owner,occupied:()=>occupiedV2(ledger.snapshot()),
      update:(limits,owner)=>this.updateResources(limits,owner),onError:options.onError
    });
    this.client=new RecoveryClient(ledger,options.connection,options.onError,{
      state:(ready,epoch)=>{this.online=ready;this.epoch=epoch;
        if(ready)this.calibration?.notify();
        if(!ready){for(const waiter of this.profileWaiters.values())waiter.reject(Error('PROFILE_CONNECTION_LOST'));this.profileWaiters.clear();}
        if(!ready)for(const id of this.pending.keys())this.scheduler.cancel(id);
        void Promise.resolve().then(()=>this.scheduler.update(ready?this.limits:[],ready?this.owner:'UNKNOWN')).catch(options.onError);
      },dispatch:message=>this.dispatch(message),evaluationChanged:()=>this.calibration?.notify(),acknowledged:message=>{this.profileWaiters.get(message.messageId)?.resolve();this.profileWaiters.delete(message.messageId);}
    });
    if(options.calibration)this.calibration=new CalibrationWorker(ledger,options.calibration.executor,allotmentTransport(options.connection),{
      domain:options.connection.domain,deviceInstanceId:options.deviceInstanceId,ready:()=>this.ready&&this.owner==='IDLE',
      authorize:async work=>this.ready&&this.owner==='IDLE'&&this.epoch===work.coordinatorEpoch,onError:options.onError
    });
  }
  get ready(){return this.online&&!this.stopped;}
  get coordinatorEpoch(){return this.epoch;}
  async publishProfile(profile:Omit<DeviceProfileV2,'sequence'>):Promise<void>{
    if(!this.ready||profile.domain!==this.options.connection.domain||profile.deviceInstanceId!==this.options.deviceInstanceId)throw Error('PROFILE_HOST_UNAVAILABLE');
    const message=this.ledger.queueProfile(profile);
    await new Promise<void>((resolve,reject)=>{
      const timeout=setTimeout(()=>{this.profileWaiters.delete(message.messageId);reject(Error('PROFILE_ACK_TIMEOUT'));},10000);
      this.profileWaiters.set(message.messageId,{resolve:()=>{clearTimeout(timeout);resolve();},reject:error=>{clearTimeout(timeout);reject(error);}});
      void this.client.flush().catch(error=>{this.profileWaiters.get(message.messageId)?.reject(error);this.profileWaiters.delete(message.messageId);});
    });
  }
  async updateResources(limits:ResourceAmountV2[],owner:'IDLE'|'ACTIVE'|'UNKNOWN'){
    const becameIdle=this.owner!=='IDLE'&&owner==='IDLE';
    this.limits=structuredClone(limits);this.owner=owner;
    await this.scheduler.update(this.online?limits:[],this.online?owner:'UNKNOWN');
    if(becameIdle)this.calibration?.notify();
  }
  private dispatch(message:MessageEnvelopeV2){
    if(this.stopped)return;
    const offer=JSON.parse(message.payload) as DispatchOfferV2,id=offer.task.attemptId,previous=this.pending.get(id);
    if(previous){if(canonical(previous.message)!==canonical(message))throw Error('INFLIGHT_DISPATCH_CONFLICT');return;}
    if(this.pending.size>=8){this.ledger.rejectDispatch(message,'AGENT_BACKPRESSURE');void this.client.flush();return;}
    const done=(async()=>{
      try{
        if(offer.target.backend!=='CPU'||offer.task.contract.interruptibility!=='CANCEL_RESTART')throw Error('EXECUTOR_UNSUPPORTED');
        const version=await this.options.snapshotVersion(offer);
        const trace=version===null?undefined:new ExecutionTrace(this.traces,{traceId:message.traceId,parentSpanId:null,snapshotVersion:version,deviceInstanceId:this.options.deviceInstanceId},offer);
        const endQueue=trace?.begin('QUEUE');
        try{await this.scheduler.submit(offer,this.options.select(offer),{message,trace,selected:()=>endQueue?.(),admitted:()=>{void this.client.flush();}});}
        finally{endQueue?.();}
      }catch(error){
        if(!this.ledger.status(id)){
          const reason=error instanceof Error&&/^[A-Z_]{1,100}(?::[A-Z_]{1,26})?$/.test(error.message)?error.message:'EXECUTION_REJECTED';
          try{this.ledger.rejectDispatch(message,reason);}catch(rejection){this.options.onError(rejection);}
        }else this.options.onError(error);
      }finally{await this.flush();this.options.onExecutionSettled?.();}
    })();
    this.pending.set(id,{message:structuredClone(message),done});void done.finally(()=>this.pending.delete(id)).catch(this.options.onError);
  }
  async flush(){
    if(!this.stopped)await this.traces.flush(async spans=>{this.ledger.queueTrace(spans);});
    await this.client.flush();
  }
  start(){
    if(this.timer||this.stopped)throw Error('AGENT_ALREADY_STARTED');this.client.start();
    if(this.allotments)this.allotments.start(this.options.allotments!.renewEveryMs);
    this.resourceMonitor?.start();
    this.calibration?.start(this.options.calibration?.intervalMs);
    this.timer=setInterval(()=>{void this.flush().catch(this.options.onError);},250);this.timer.unref();
  }
  async close(){
    if(this.stopped)return;this.stopped=true;if(this.timer)clearInterval(this.timer);
    await this.calibration?.close();await this.resourceMonitor?.close();await this.allotments?.close();await this.client.close();await this.scheduler.close();await Promise.allSettled([...this.pending.values()].map(p=>p.done));
  }
}
