import {Peer} from './channel';
interface TaskActivity {taskId:string;operation:string;phase:string;state:string;startedAt:number;updatedAt:number;error:string;}
interface AppActivity {sampledAt:number;processMemoryBytes:number|null;processCpuUsage?:number|null;tasks:TaskActivity[];}
interface Observation {holderInstanceId:string;deviceId:string;appId:string;receivedAt:number;activity:AppActivity;}
/** Display-only bounded observations. No writes to resource, job or planning state. */
export class AppActivityStore {
 private samples=new Map<string,Observation>();
 constructor(private now:()=>number=Date.now){}
 report(peer:Peer,input:AppActivity):void {
  if(!peer.app)throw Error('APP_REGISTRATION_REQUIRED');
  const now=this.now();
  if(!input||!['processMemoryBytes|sampledAt|tasks','processCpuUsage|processMemoryBytes|sampledAt|tasks'].includes(Object.keys(input).sort().join('|'))||!Number.isSafeInteger(input.sampledAt)||Math.abs(input.sampledAt-now)>60000||
   input.processMemoryBytes!==null&&(!Number.isSafeInteger(input.processMemoryBytes)||input.processMemoryBytes<0||input.processMemoryBytes>1099511627776)||
   input.processCpuUsage!==undefined&&input.processCpuUsage!==null&&(!Number.isFinite(input.processCpuUsage)||input.processCpuUsage<0)||
   !Array.isArray(input.tasks)||input.tasks.length>20)throw Error('APP_ACTIVITY_INVALID');
  for(const task of input.tasks)if(!task||Object.keys(task).sort().join('|')!=='error|operation|phase|startedAt|state|taskId|updatedAt'||
   !/^[A-Za-z0-9_.:-]{1,128}$/.test(task.taskId)||!['text','image_upload','refine','read','turn','more','prices','answer','subject','profile'].includes(task.operation)||
   !['PREPARING','AUTHORIZING','PROBING','CLOUD_REQUEST','BUSINESS_COMPUTE','FINISHED'].includes(task.phase)||
   !['RUNNING','SUCCEEDED','FAILED','CANCELLED','TIMED_OUT'].includes(task.state)||typeof task.error!=='string'||task.error.length>160||
   !Number.isSafeInteger(task.startedAt)||!Number.isSafeInteger(task.updatedAt)||task.startedAt<0||task.startedAt>task.updatedAt||task.updatedAt>input.sampledAt+1000)throw Error('APP_ACTIVITY_INVALID');
  if(new Set(input.tasks.map(t=>t.taskId)).size!==input.tasks.length)throw Error('APP_ACTIVITY_INVALID');
  for(const [key,value] of this.samples)if(now-value.receivedAt>=60000)this.samples.delete(key);
  const key=JSON.stringify([peer.groupId,peer.deviceId,peer.holderInstanceId]);
  if((this.samples.get(key)?.activity.sampledAt??-1)>input.sampledAt)return;
  this.samples.delete(key);if(this.samples.size>=2048)this.samples.delete(this.samples.keys().next().value!);
  this.samples.set(key,{holderInstanceId:peer.holderInstanceId,deviceId:peer.deviceId,appId:peer.app.appId,receivedAt:now,activity:structuredClone(input)});
 }
 read(groupId:string,deviceId:string,holderIds:string[]):Observation[] {
  const now=this.now();return holderIds.map(id=>this.samples.get(JSON.stringify([groupId,deviceId,id])))
   .filter((v):v is Observation=>!!v&&now-v.receivedAt<15000&&now-v.activity.sampledAt<15000);
 }
}
