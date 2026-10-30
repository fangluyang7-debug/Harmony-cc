import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MicroQueue } from '../src/micro-queue';
const base=JSON.parse(readFileSync(resolve(__dirname,'../../../contracts/scheduling/v2/fixtures/t2/valid/DispatchOffer.json'),'utf8'));
const policy={shares:[.5,.3,.2],agingMs:100,maxConsecutive:2,yieldDeadlineMs:1000};
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
