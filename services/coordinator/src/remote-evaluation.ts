import { PrismaClient } from '../generated/client';
import { canonical, ExecutorV2 } from '@harmony/scheduler-core';
import { EvaluationWork, EvaluationReport, validEvaluationPermit, decodeEvaluationReport } from '@harmony/resource-transport';
import { DeviceDirectory, executorIdentity } from './directory';
import { Peer } from './channel';
import { EvaluationRunner, EvaluationPermit, EvaluationCase, EvaluationResult } from './qualification';

/** Durable pull mailbox. A claimed permit is never issued as RUN again, even when delivery was uncertain. */
export class RemoteEvaluationRunner implements EvaluationRunner {
  private closed=false;
  private readonly listeners=new Set<(groupId:string,holderInstanceId:string)=>void>();
  onChanged(listener:(groupId:string,holderInstanceId:string)=>void){this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
  private changed(groupId:string,holderInstanceId:string){for(const listener of this.listeners)listener(groupId,holderInstanceId);}
  constructor(private readonly db:PrismaClient,private readonly directory:DeviceDirectory,private readonly epoch:()=>number){}
  async run(permit:EvaluationPermit,_test:EvaluationCase,executor:ExecutorV2,signal:AbortSignal):Promise<EvaluationResult>{
    if(this.closed||signal.aborted||!validEvaluationPermit(permit)||permit.domain!==this.directory.domain||executorIdentity(executor)!==permit.identity)throw Error('REMOTE_EVALUATION_INVALID');
    const profile=(await this.directory.profiles(permit.groupId)).find(p=>p.holderInstanceId===permit.holderInstanceId&&p.executors.some(e=>executorIdentity(e)===permit.identity));
    if(!profile)throw Error('REMOTE_EVALUATION_TARGET');
    const work:EvaluationWork={permit,executor,coordinatorEpoch:this.epoch(),ledgerEpoch:profile.ledgerEpoch,deviceInstanceId:profile.deviceInstanceId,expiresAt:Date.now()+permit.timeoutMs,mode:'RUN'};
    await this.db.$transaction(async tx=>{
      if(await tx.evaluationDispatch.count({where:{groupId:permit.groupId,holderInstanceId:permit.holderInstanceId,state:{not:'SETTLED'}}})>=8)throw Error('EVALUATION_BACKPRESSURE');
      await tx.evaluationDispatch.create({data:{id:permit.id,groupId:permit.groupId,holderInstanceId:permit.holderInstanceId,deviceId:executor.target.deviceId,epoch:this.epoch(),state:'QUEUED',expiresAt:work.expiresAt,workJson:JSON.stringify(work)}});
    });
    this.changed(permit.groupId,permit.holderInstanceId);
    while(!this.closed&&!signal.aborted&&Date.now()<work.expiresAt){
      const result=await this.reconcile(permit);if(result)return result;
      await new Promise<void>(resolve=>setTimeout(resolve,50));
    }
    await this.cancel(permit.id);
    this.changed(permit.groupId,permit.holderInstanceId);
    throw Error('EVALUATION_SETTLEMENT_UNKNOWN');
  }
  private async cancel(id:string){
    // An unclaimed row proves it never crossed the delivery boundary. Claimed work needs actual engine settlement.
    await this.db.$transaction(async tx=>{
      const row=await tx.evaluationDispatch.findUniqueOrThrow({where:{id}});
      if(row.state==='SETTLED')return;
      const work:EvaluationWork=JSON.parse(row.workJson);
      await tx.evaluationDispatch.update({where:{id},data:row.state==='QUEUED'?{state:'SETTLED',resultJson:JSON.stringify({settled:true,output:'',durationMs:0,permitId:id,domain:work.permit.domain})}:{state:'CANCEL_REQUESTED'}});
    });
  }
  async reconcile(permit:EvaluationPermit):Promise<EvaluationResult|null>{
    const row=await this.db.evaluationDispatch.findUnique({where:{id:permit.id}});if(!row)return null;
    const work:EvaluationWork=JSON.parse(row.workJson);
    if(canonical(work.permit)!==canonical(permit))throw Error('EVALUATION_PERMIT_CONFLICT');
    return row.state==='SETTLED'&&row.resultJson?decodeEvaluationReport(JSON.parse(row.resultJson),permit):null;
  }
  async claim(peer:Peer):Promise<EvaluationWork|null>{
    if(this.closed)throw Error('EVALUATION_CLOSED');
    return this.db.$transaction(async tx=>{
      const rows=await tx.evaluationDispatch.findMany({where:{groupId:peer.groupId,holderInstanceId:peer.holderInstanceId,deviceId:peer.deviceId,state:{not:'SETTLED'}},orderBy:{expiresAt:'asc'},take:8});
      for(const row of rows){
        const work:EvaluationWork=JSON.parse(row.workJson);
        if(row.state!=='QUEUED')return {...work,mode:'RECONCILE'};
        const profile=(await this.directory.profiles(peer.groupId,tx)).find(p=>p.holderInstanceId===peer.holderInstanceId&&p.deviceId===peer.deviceId);
        if(row.expiresAt<=Date.now()||row.epoch!==this.epoch()||!profile||profile.ledgerEpoch!==work.ledgerEpoch||profile.deviceInstanceId!==work.deviceInstanceId||!profile.executors.some(e=>executorIdentity(e)===work.permit.identity)){
          await tx.evaluationDispatch.update({where:{id:row.id},data:{state:'SETTLED',resultJson:JSON.stringify({settled:true,output:'',durationMs:0,permitId:row.id,domain:work.permit.domain})}});continue;
        }
        await tx.evaluationDispatch.update({where:{id:row.id},data:{state:'CLAIMED'}});
        return work;
      }
      return null;
    });
  }
  async status(peer:Peer,id:string){
    const row=await this.scoped(peer,id);
    return {cancel:row.state==='CANCEL_REQUESTED'||row.epoch!==this.epoch()||row.expiresAt<=Date.now(),settled:row.state==='SETTLED'};
  }
  private async scoped(peer:Peer,id:string){
    const row=await this.db.evaluationDispatch.findUnique({where:{id}});
    if(!row||row.groupId!==peer.groupId||row.holderInstanceId!==peer.holderInstanceId||row.deviceId!==peer.deviceId)throw Error('EVALUATION_SCOPE');
    return row;
  }
  async report(peer:Peer,id:string,report:EvaluationReport){
    const row=await this.scoped(peer,id),work:EvaluationWork=JSON.parse(row.workJson);
    decodeEvaluationReport(report,work.permit);
    if(row.state==='QUEUED')throw Error('EVALUATION_NOT_CLAIMED');
    const encoded=canonical(report);
    // Compare-and-set makes simultaneous duplicate reports harmless and conflicting reports immutable.
    const result=await this.db.evaluationDispatch.updateMany({where:{id,state:{in:['CLAIMED','CANCEL_REQUESTED']},resultJson:null},data:{state:'SETTLED',resultJson:encoded}});
    if(!result.count){const latest=await this.scoped(peer,id);if(!latest.resultJson||canonical(JSON.parse(latest.resultJson))!==encoded)throw Error('EVALUATION_REPORT_CONFLICT');}
    return {acknowledged:true};
  }
  close(){this.closed=true;}
}
