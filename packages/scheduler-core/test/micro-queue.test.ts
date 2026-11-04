import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MicroQueue } from '../src/micro-queue';
const base=JSON.parse(readFileSync(resolve(__dirname,'../../../contracts/scheduling/v2/fixtures/t2/valid/DispatchOffer.json'),'utf8'));
const policy={shares:[.5,.3,.2],agingMs:100,maxConsecutive:2,yieldDeadlineMs:1000};
test('waiting cap can expire before the original deadline and never expires a running attempt',()=>{
 const q=new MicroQueue('device1',{...policy,maxQueueWaitMs:25});
 q.enqueue(offer('waiting'),10);q.enqueue(offer('running'),10);q.start('running',10);
 expect(q.expired(34)).toEqual([]);expect(q.expired(35)).toEqual(['waiting']);
 expect(()=>new MicroQueue('device1',{...policy,maxQueueWaitMs:0})).toThrow('QUEUE_POLICY_INVALID');
});
test('repeated measured same-pool interference delays coexecution until the incumbent settles',()=>{
 const q=new MicroQueue('device1',policy),limits=[{resourcePoolId:'cpu1',amount:2},{resourcePoolId:'gpu1',amount:1}];
 let now=0;
 for(let i=0;i<5;i++){
  const a=offer('solo'+i);q.enqueue(a,now);q.start(a.task.attemptId,now);now+=10;q.settle(a.task.attemptId,now,true);
 }
 for(let i=0;i<3;i++){
  const a=offer('a'+i),b=offer('b'+i);b.task.parameters='{"kind":"neighbor"}';
  q.enqueue(a,now);q.start(a.task.attemptId,now);q.enqueue(b,now);
  expect(q.choose(limits,a.resources,now,true)?.task.attemptId).toBe(b.task.attemptId);
  q.start(b.task.attemptId,now);now+=35;q.settle(a.task.attemptId,now,true);q.settle(b.task.attemptId,now,true);
 }
 const a=offer('active'),b=offer('queued');b.task.parameters='{"kind":"neighbor"}';
 q.enqueue(a,now);q.start('active',now);q.enqueue(b,now);
 expect(q.choose(limits,a.resources,now,true)).toBeNull();
 expect(q.waitingReasons(limits,a.resources,true,null)[0]).toEqual({attemptId:'queued',reasonCode:'SHARED_POOL_INTERFERENCE',resourcePoolIds:['cpu1']});
 const independent=offer('other','REMOTE_BATCH','gpu1');q.enqueue(independent,now);
 expect(q.choose(limits,a.resources,now,true)?.task.attemptId).toBe('other');q.removeWaiting('other');
 q.settle('active',now+10,true);expect(q.choose(limits,[],now+10,true)?.task.attemptId).toBe('queued');
});
function offer(id:string,priority='REMOTE_INTERACTIVE',pool='cpu1'){const o=JSON.parse(JSON.stringify(base));o.task.attemptId=id;o.task.priority=priority;o.task.originDeviceId='device1';o.task.budget={remainingMs:10000,deadlineAt:10000};o.target.resourcePoolIds=[pool];o.resources=[{resourcePoolId:pool,amount:1}];return o;}
test('independent pools progress; shared resource admission blocks only its consumers',()=>{
 const q=new MicroQueue('device1',policy);q.enqueue(offer('cpu'),0);q.enqueue(offer('gpu','REMOTE_BATCH','gpu1'),0);
 const limits=[{resourcePoolId:'cpu1',amount:1},{resourcePoolId:'gpu1',amount:1}];
 expect(q.choose(limits,[{resourcePoolId:'cpu1',amount:1}],1,true)!.task.attemptId).toBe('gpu');
 expect(q.choose(limits,limits,1,true)).toBeNull();expect(q.choose(limits,[],1,false)).toBeNull();
 const spoof=offer('spoof','ORIGIN_INTERACTIVE');spoof.task.originDeviceId='remote';expect(()=>q.enqueue(spoof,0)).toThrow('INVALID');
});
test('guaranteed share debt, aging and bounded service let a waiting lower category progress without changing its identity',()=>{
 const q=new MicroQueue('device1',policy),limits=[{resourcePoolId:'cpu1',amount:1}];q.enqueue(offer('batch','REMOTE_BATCH'),0);
 for(let i=0;i<10;i++)q.enqueue(offer('interactive'+i,'ORIGIN_INTERACTIVE'),0);
 const seen:string[]=[];for(let i=0;i<8;i++){const next=q.choose(limits,[],i*10,true)!;seen.push(next.task.priority);q.start(next.task.attemptId,i*10);q.settle(next.task.attemptId,i*10+5);}
 expect(seen.indexOf('REMOTE_BATCH')).toBeGreaterThanOrEqual(0);expect(seen.indexOf('REMOTE_BATCH')).toBeLessThanOrEqual(2);
});
test('owner yield is intent only; running entries cannot be removed and expiry never settles them',()=>{
 const q=new MicroQueue('device1',policy),o=offer('job');o.task.contract.maxNonPreemptibleMs=50;q.enqueue(o,0);q.start('job',1);
 expect(q.ownerYield(60)[0].reasonCode).toBe('RELEASE_OVERDUE');expect(()=>q.removeWaiting('job')).toThrow('RUNNING');expect(q.expired(20000)).toEqual([]);
 q.settle('job',70);expect(q.ownerYield(71)).toEqual([]);
});

test('waiting evidence separates actual occupancy, owner protection and local queue policy without changing selection',()=>{
 const q=new MicroQueue('device1',policy),limits=[{resourcePoolId:'cpu1',amount:1}];
 q.enqueue(offer('a'),0);q.enqueue(offer('b'),0);
 const selected=q.choose(limits,[],1,true)!.task.attemptId;
 expect(q.waitingReasons(limits,limits,true,null).every(e=>e.reasonCode==='RESOURCE_CAPACITY'&&e.resourcePoolIds[0]==='cpu1')).toBe(true);
 expect(q.waitingReasons(limits,[],false,null).every(e=>e.reasonCode==='OWNER_ACTIVE')).toBe(true);
 expect(q.waitingReasons(limits,[],true,selected)).toEqual([{attemptId:selected==='a'?'b':'a',reasonCode:'LOCAL_QUEUE_POLICY',resourcePoolIds:[]}]);
 expect(q.choose(limits,[],1,true)!.task.attemptId).toBe(selected);
 expect(q.waitingReasons(limits,[],true,null).every(e=>e.reasonCode==='QUEUE_WAIT_UNKNOWN')).toBe(true);
});
