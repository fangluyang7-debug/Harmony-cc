import { CoordinatorDatabase, CoordinatorTransaction } from './CoordinatorDatabase';
import { CoordinatorPeer } from './CoordinatorCredentials';
export interface AppTaskActivity {taskId:string;operation:string;phase:string;state:string;startedAt:number;updatedAt:number;error:string;}
export interface AppActivity {sampledAt:number;processMemoryBytes:number|null;processCpuUsage?:number|null;tasks:AppTaskActivity[];}
export interface StoredAppActivity {holderInstanceId:string;deviceId:string;appId:string;receivedAt:number;activity:AppActivity;}
export interface DeviceTelemetry {sampledAt:number;cpuPercent:number|null;memoryUsedBytes:number;memoryTotalBytes:number;batteryPercent:number|null;powerStatus:string;gpuPercent:number|null;gpuTemperatureC:number|null;gpuName:string;sensorSampledAt:number;}
export interface StoredDeviceTelemetry {holderInstanceId:string;deviceId:string;receivedAt:number;sample:DeviceTelemetry;}
/** Application observations never reserve resources or manufacture dispatch attempts. */
export class CoordinatorActivity {
 private database:CoordinatorDatabase;
 constructor(database:CoordinatorDatabase){this.database=database;}
 async device(peer:CoordinatorPeer,input:DeviceTelemetry):Promise<void>{
  const now=Date.now();
  if(peer.app||!input||Object.keys(input).sort().join('|')!=='batteryPercent|cpuPercent|gpuName|gpuPercent|gpuTemperatureC|memoryTotalBytes|memoryUsedBytes|powerStatus|sampledAt|sensorSampledAt'||
   !Number.isSafeInteger(input.sampledAt)||Math.abs(input.sampledAt-now)>60000||!Number.isSafeInteger(input.sensorSampledAt)||input.sensorSampledAt<0||input.sensorSampledAt>now+60000||
   !Number.isSafeInteger(input.memoryTotalBytes)||input.memoryTotalBytes<=0||!Number.isSafeInteger(input.memoryUsedBytes)||input.memoryUsedBytes<0||input.memoryUsedBytes>input.memoryTotalBytes||
   ![input.cpuPercent,input.batteryPercent,input.gpuPercent].every(v=>v===null||typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100)||
   input.gpuTemperatureC!==null&&(!Number.isFinite(input.gpuTemperatureC)||input.gpuTemperatureC<0||input.gpuTemperatureC>150)||
   typeof input.gpuName!=='string'||input.gpuName.length>200||!['UNKNOWN','NO_BATTERY','CHARGING','DISCHARGING','AC_POWER'].includes(input.powerStatus))throw Error('DEVICE_TELEMETRY_INVALID');
  const value:StoredDeviceTelemetry={holderInstanceId:peer.holderInstanceId,deviceId:peer.deviceId,receivedAt:now,sample:input};
  await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{await tx.executeSql('INSERT INTO Device (id,groupId,revision,metadataJson) VALUES (?,?,1,?) ON CONFLICT(id) DO UPDATE SET revision=revision+1,metadataJson=excluded.metadataJson',[JSON.stringify(['device-telemetry',peer.groupId,peer.holderInstanceId]),peer.groupId,JSON.stringify(value)]);});
 }
 async report(peer:CoordinatorPeer,input:AppActivity):Promise<void>{
  if(!peer.app)throw Error('APP_REGISTRATION_REQUIRED');
  const now=Date.now();
  if(!input||!['processMemoryBytes|sampledAt|tasks','processCpuUsage|processMemoryBytes|sampledAt|tasks'].includes(Object.keys(input).sort().join('|'))||!Number.isSafeInteger(input.sampledAt)||Math.abs(input.sampledAt-now)>60000||
   input.processMemoryBytes!==null&&(!Number.isSafeInteger(input.processMemoryBytes)||input.processMemoryBytes<0||input.processMemoryBytes>1099511627776)||
   input.processCpuUsage!==undefined&&input.processCpuUsage!==null&&(!Number.isFinite(input.processCpuUsage)||input.processCpuUsage<0)||
   !Array.isArray(input.tasks)||input.tasks.length>20)throw Error('APP_ACTIVITY_INVALID');
  for(const task of input.tasks){
   if(!task||Object.keys(task).sort().join('|')!=='error|operation|phase|startedAt|state|taskId|updatedAt'||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(task.taskId)||!['text','image_upload','refine','read','turn','more','prices','answer','subject','profile'].includes(task.operation)||
    !['PREPARING','AUTHORIZING','PROBING','CLOUD_REQUEST','BUSINESS_COMPUTE','FINISHED'].includes(task.phase)||
    !['RUNNING','SUCCEEDED','FAILED','CANCELLED','TIMED_OUT'].includes(task.state)||typeof task.error!=='string'||task.error.length>160||
    !Number.isSafeInteger(task.startedAt)||!Number.isSafeInteger(task.updatedAt)||task.startedAt>task.updatedAt||task.updatedAt>input.sampledAt+1000)throw Error('APP_ACTIVITY_INVALID');
  }
  if(new Set(input.tasks.map(t=>t.taskId)).size!==input.tasks.length)throw Error('APP_ACTIVITY_INVALID');
  const id=JSON.stringify(['app-activity',peer.groupId,peer.holderInstanceId]);
  const value:StoredAppActivity={holderInstanceId:peer.holderInstanceId,deviceId:peer.deviceId,appId:peer.app.appId,receivedAt:now,activity:input};
  await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{
   await tx.executeSql('INSERT INTO Device (id,groupId,revision,metadataJson) VALUES (?,?,1,?) ON CONFLICT(id) DO UPDATE SET revision=revision+1,metadataJson=excluded.metadataJson',[id,peer.groupId,JSON.stringify(value)]);
  });
 }
}
