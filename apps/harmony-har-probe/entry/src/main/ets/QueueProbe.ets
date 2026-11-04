import {DispatchOfferV2,MicroQueueV2,QueuePolicyV2,ResourceAmountV2} from 'scheduler';

/** Runs the native HAR implementation against synthetic load on the emulator's own Ark runtime. */
export function verifyQueue(base:DispatchOfferV2):void{
 const policy:QueuePolicyV2={shares:[0.5,0.3,0.2],agingMs:100,maxConsecutive:2,yieldDeadlineMs:1000,maxQueueWaitMs:500};
 const q=new MicroQueueV2(base.target.deviceId,policy);
 const limits:ResourceAmountV2[]=[{resourcePoolId:'cpu1',amount:2},{resourcePoolId:'gpu1',amount:1}];
 const make=(id:string,pool:string,parameters:string):DispatchOfferV2=>{
  const offer=JSON.parse(JSON.stringify(base)) as DispatchOfferV2;
  offer.task.attemptId=id;offer.task.parameters=parameters;offer.task.priority='REMOTE_INTERACTIVE';
  offer.task.budget={remainingMs:5000,deadlineAt:5000};offer.target.resourcePoolIds=[pool];offer.resources=[{resourcePoolId:pool,amount:1}];
  return offer;
 };
 let now=0;
 for(let i=0;i<5;i++){const id='solo'+i;q.enqueue(make(id,'cpu1','{}'),now);q.start(id,now);now+=10;q.settle(id,now,true);}
 for(let i=0;i<3;i++){
  const a='a'+i,b='b'+i;q.enqueue(make(a,'cpu1','{}'),now);q.start(a,now);
  q.enqueue(make(b,'cpu1','{"neighbor":1}'),now);q.start(b,now);now+=35;q.settle(a,now,true);q.settle(b,now,true);
 }
 const held=make('running','cpu1','{}');q.enqueue(held,now);q.start('running',now);
 q.enqueue(make('wait','cpu1','{"neighbor":1}'),now);
 if(q.choose(limits,held.resources,now,true)!==null||
   q.waitingReasons(limits,held.resources,true,null)[0].reasonCode!=='SHARED_POOL_INTERFERENCE')throw Error('NATIVE_INTERFERENCE_GATE');
 q.enqueue(make('other','gpu1','{}'),now);
 if(q.choose(limits,held.resources,now,true)?.task.attemptId!=='other'||q.choose(limits,held.resources,now,false)!==null)throw Error('NATIVE_OWNER_OR_POOL_GATE');
 q.removeWaiting('other');
 if(q.expired(now+500).join(',')!=='wait')throw Error('NATIVE_WAITING_CAP');
 q.settle('running',now+10,true);
 if(q.choose(limits,[],now+10,true)?.task.attemptId!=='wait')throw Error('NATIVE_SETTLEMENT_GATE');
}
