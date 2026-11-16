import {Peer} from './channel';

export interface DeviceTelemetry {
  sampledAt:number; cpuPercent:number|null; memoryUsedBytes:number; memoryTotalBytes:number;
  batteryPercent:number|null; powerStatus:string; gpuPercent:number|null; gpuTemperatureC:number|null;
  gpuName:string; sensorSampledAt:number;
}
interface Observation {holderInstanceId:string;deviceId:string;receivedAt:number;sample:DeviceTelemetry;}
/** Volatile display observations: no SQLite writes, admission changes or planning invalidation. */
export class DeviceTelemetryStore {
  private samples=new Map<string,Observation>();
  constructor(private now:()=>number=Date.now){}
  report(peer:Peer,input:DeviceTelemetry):void {
    const now=this.now();
    if(peer.app)throw Error('DEVICE_TELEMETRY_FORBIDDEN');
    if(!input||Object.keys(input).sort().join('|')!=='batteryPercent|cpuPercent|gpuName|gpuPercent|gpuTemperatureC|memoryTotalBytes|memoryUsedBytes|powerStatus|sampledAt|sensorSampledAt'||
      !Number.isSafeInteger(input.sampledAt)||Math.abs(input.sampledAt-now)>60000||
      !Number.isSafeInteger(input.sensorSampledAt)||input.sensorSampledAt<0||input.sensorSampledAt>now+60000||
      !Number.isSafeInteger(input.memoryTotalBytes)||input.memoryTotalBytes<=0||!Number.isSafeInteger(input.memoryUsedBytes)||input.memoryUsedBytes<0||input.memoryUsedBytes>input.memoryTotalBytes||
      ![input.cpuPercent,input.batteryPercent,input.gpuPercent].every(v=>v===null||typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100)||
      input.gpuTemperatureC!==null&&(!Number.isFinite(input.gpuTemperatureC)||input.gpuTemperatureC<0||input.gpuTemperatureC>150)||
      typeof input.gpuName!=='string'||input.gpuName.length>200||!['UNKNOWN','NO_BATTERY','CHARGING','DISCHARGING','AC_POWER'].includes(input.powerStatus))throw Error('DEVICE_TELEMETRY_INVALID');
    for(const [key,value] of this.samples)if(now-value.receivedAt>=60000)this.samples.delete(key);
    const key=JSON.stringify([peer.groupId,peer.deviceId,peer.holderInstanceId]);
    if((this.samples.get(key)?.sample.sampledAt??-1)>input.sampledAt)return;
    this.samples.delete(key);
    if(this.samples.size>=2048)this.samples.delete(this.samples.keys().next().value!);
    this.samples.set(key,{holderInstanceId:peer.holderInstanceId,deviceId:peer.deviceId,receivedAt:now,sample:{...input}});
  }
  read(groupId:string,deviceId:string,holderIds:string[]):Observation|null {
    const now=this.now();
    const values=holderIds.map(id=>this.samples.get(JSON.stringify([groupId,deviceId,id])))
      .filter((v):v is Observation=>!!v&&now-v.receivedAt<15000&&now-v.sample.sampledAt<15000);
    return values.sort((a,b)=>b.receivedAt-a.receivedAt)[0]??null;
  }
}
