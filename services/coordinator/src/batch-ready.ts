import type {ResourceAmountV2} from '@harmony/scheduler-core';
import {BatchReadyJob,Prisma,PrismaClient} from '../generated/client';
import {Peer} from './channel';

const retryable=new Set(['ALLOTMENT_UNAVAILABLE','ALLOTMENT_ACK_PENDING','NO_LEGAL_PLAN','PLAN_STALE','APP_QUOTA_EXCEEDED','START_BUSY','TARGET_UNAVAILABLE','JOB_RECOVERY_REQUIRED','INPUT_NOT_UPLOADED']);
/** A timestamped observation of coordinator queueing, excluding device execution and result return. */
export function readyWait(row:BatchReadyJob,until:number,outcome:'OFFERED'|'EXPIRED'|'REFUSED'){
  return JSON.stringify({queuedAt:row.queuedAt,endedAt:until,waitMs:Math.max(0,until-row.queuedAt),priority:row.priority,
    outcome,lastBlock:row.reason==='READY'?null:row.reason});
}
/** Charge normalized physical resource time once in the offer transaction. */
export async function chargeBatch(tx:Prisma.TransactionClient,id:string,appId:string,deviceId:string,demand:ResourceAmountV2[],estimatedMs:number){
  const app=await tx.registeredApp.findUniqueOrThrow({where:{id:appId}});
  const device=await tx.device.findUniqueOrThrow({where:{id:JSON.stringify(['budget',deviceId])}});
  const capacity:ResourceAmountV2[]=JSON.parse(device.metadataJson).capacity;
  let share=0;
  for(const resource of demand.filter(r=>r.amount>0)){
    const total=capacity.find(r=>r.resourcePoolId===resource.resourcePoolId)?.amount;
    if(!total||resource.amount>total)throw Error('ALLOTMENT_UNAVAILABLE');
    share=Math.max(share,resource.amount/total);
  }
  const rate=share/app.batchWeight;
  await tx.batchCharge.create({data:{id,appId,rate,estimatedMs}});
  await tx.registeredApp.update({where:{id:appId},data:{batchService:{increment:estimatedMs*rate}}});
}

export async function settleBatchCharge(tx:Prisma.TransactionClient,id:string,actualMs:number|undefined){
  if(actualMs===undefined)return;
  const charge=await tx.batchCharge.findUnique({where:{id}});
  if(!charge||charge.actualMs!==null)return;
  const won=await tx.batchCharge.updateMany({where:{id,actualMs:null},data:{actualMs}});
  if(won.count)await tx.registeredApp.update({where:{id:charge.appId},data:{batchService:{increment:(actualMs-charge.estimatedMs)*charge.rate}}});
}
/** Input is staged before enqueue. The only dispatcher is the normal CpuJobs start path. */
export class BatchReadyQueue {
  private readonly activeGroups=new Set<string>();
  private readonly groups=new Set<string>();
  private readonly timers=new Map<string,NodeJS.Timeout>();
  private readonly lastClass=new Map<string,string>();
  private readonly lastApp=new Map<string,string>();
  private readonly workers=new Map<string,Promise<void>>();
  private closed=false;
  constructor(private readonly db:PrismaClient,private readonly dispatch:(peer:Peer,id:string)=>Promise<unknown>){}
  hasBacklog(group:string){return this.activeGroups.has(group);}
  async enqueue(peer:Peer,id:string,deadlineAt:number,priority='REMOTE_BATCH'){
    if(!peer.app)throw Error('APP_REGISTRATION_REQUIRED');
    const queued=await this.db.$transaction(async tx=>{
      const job=await tx.cpuJob.findUniqueOrThrow({where:{id}});
      if(!['WAITING_INPUT','DISPATCHING'].includes(job.state))return false;
      const backlogged=await tx.batchReadyJob.findMany({where:{groupId:peer.groupId,priority:'REMOTE_BATCH'},select:{appId:true},distinct:['appId']});
      if(priority==='REMOTE_BATCH'&&backlogged.length&&!backlogged.some(r=>r.appId===peer.app!.appId)){
        const floor=await tx.registeredApp.aggregate({where:{id:{in:backlogged.map(r=>r.appId)}},_min:{batchService:true}});
        const min=floor._min.batchService;
        if(min!==null)await tx.registeredApp.updateMany({where:{id:peer.app!.appId,batchService:{lt:min}},data:{batchService:min}});
      }
      await tx.batchReadyJob.upsert({where:{id},update:{},create:{id,groupId:peer.groupId,appId:peer.app!.appId,
        priority,peerJson:JSON.stringify(peer),queuedAt:Date.now(),deadlineAt,reason:'READY'}});
      return true;
    });
    if(queued){this.activeGroups.add(peer.groupId);this.changed(peer.groupId);}
    return queued;
  }
  changed(group:string){
    if(this.closed||!this.activeGroups.has(group))return;
    this.groups.add(group);
    if(!this.workers.has(group)){
      const work=Promise.resolve().then(()=>this.process(group)).finally(()=>{
        this.workers.delete(group);
        if(this.groups.has(group))this.changed(group);
      });
      this.workers.set(group,work);
    }
  }
  async restore(){
    for(const row of await this.db.batchReadyJob.findMany({select:{groupId:true},distinct:['groupId']})){this.activeGroups.add(row.groupId);this.changed(row.groupId);}
  }
  private async process(group:string){
    while(!this.closed&&this.groups.delete(group)){
      try{await this.pass(group);}catch(error){console.warn('BATCH_QUEUE_STORE_RETRY',error instanceof Error?error.name:'UNKNOWN');this.wake(group,Date.now()+1000);}
    }
  }
  private wake(group:string,at:number){
    clearTimeout(this.timers.get(group));this.timers.delete(group);
    if(!this.closed&&Number.isFinite(at)){
      const timer=setTimeout(()=>{this.timers.delete(group);this.changed(group);},Math.max(1,at-Date.now()));timer.unref();this.timers.set(group,timer);
    }
  }
  private async pass(group:string){
    const rows=await this.db.batchReadyJob.findMany({where:{groupId:group},orderBy:[{queuedAt:'asc'},{id:'asc'}]});
    const classes=new Map<string,Map<string,BatchReadyJob>>();
    let deadline=Infinity;
    for(const row of rows){
      if(row.deadlineAt<=Date.now()){await this.tryDispatch(row);continue;}
      deadline=Math.min(deadline,row.deadlineAt);
      let apps=classes.get(row.priority);
      if(!apps){apps=new Map();classes.set(row.priority,apps);}
      if(!apps.has(row.appId))apps.set(row.appId,row);
    }
    const order=this.lastClass.get(group)==='REMOTE_INTERACTIVE'?['REMOTE_BATCH','REMOTE_INTERACTIVE']:['REMOTE_INTERACTIVE','REMOTE_BATCH'];
    for(const priority of order){
      const apps=classes.get(priority);if(!apps)continue;
      const ids=[...apps.keys()],key=JSON.stringify([group,priority]),cursor=ids.indexOf(this.lastApp.get(key)??'')+1;
      const candidates=[...ids.slice(cursor),...ids.slice(0,cursor)];
      if(priority==='REMOTE_BATCH'){
        const accounts=await this.db.registeredApp.findMany({where:{id:{in:ids}},select:{id:true,batchService:true}});
        const service=new Map(accounts.map(a=>[a.id,a.batchService]));
        candidates.sort((a,b)=>(service.get(a)??0)-(service.get(b)??0));
      }
      let advanced=false;
      for(const app of candidates){
        if(this.closed)break;
        const outcome=await this.tryDispatch(apps.get(app)!);
        if(outcome==='WAIT')continue;
        if(outcome==='SENT'){this.lastClass.set(group,priority);this.lastApp.set(key,app);}
        this.groups.add(group);advanced=true;break;
      }
      if(advanced)break;
    }
    if(!classes.size&&!this.groups.has(group)){
      this.activeGroups.delete(group);this.lastClass.delete(group);
      for(const priority of order)this.lastApp.delete(JSON.stringify([group,priority]));
    }
    this.wake(group,deadline);
  }
  private async tryDispatch(row:BatchReadyJob){
    let sent=false;
    const job=await this.db.cpuJob.findUnique({where:{id:row.id}});
    if(job&&['WAITING_INPUT','DISPATCHING'].includes(job.state)){
      try{
        if(row.deadlineAt<=Date.now())throw Error('BUDGET_EXHAUSTED');
        await this.dispatch(JSON.parse(row.peerJson) as Peer,row.id);sent=true;
      }catch(error){
        if(!(error instanceof Error)||!/^[A-Z][A-Z0-9_:]+$/.test(error.message))throw error;
        const reason=error.message;
        if(retryable.has(reason)){
          await this.db.batchReadyJob.updateMany({where:{id:row.id},data:{reason}});
          return 'WAIT';
        }
        // Never overwrite an attempt or its receipt on an ambiguous dispatch.
        await this.db.$transaction(async tx=>{
          if(!await tx.attempt.findUnique({where:{id:row.id}}))
            await tx.cpuJob.updateMany({where:{id:row.id,state:{in:['WAITING_INPUT','DISPATCHING']}},data:{state:reason==='BUDGET_EXHAUSTED'?reason:'FAILED',
              readyWaitJson:readyWait(row,Date.now(),reason==='BUDGET_EXHAUSTED'?'EXPIRED':'REFUSED')}});
          await tx.batchReadyJob.deleteMany({where:{id:row.id}});
        });
        return 'REMOVED';
      }
    }
    await this.db.batchReadyJob.deleteMany({where:{id:row.id}});
    return sent?'SENT':'REMOVED';
  }
  async close(){this.closed=true;for(const timer of this.timers.values())clearTimeout(timer);await Promise.all(this.workers.values());}
}
