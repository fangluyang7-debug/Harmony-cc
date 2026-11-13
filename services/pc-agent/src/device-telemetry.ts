import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
export interface DeviceTelemetry {sampledAt:number;cpuPercent:number|null;memoryUsedBytes:number;memoryTotalBytes:number;batteryPercent:number|null;powerStatus:string;gpuPercent:number|null;gpuTemperatureC:number|null;gpuName:string;sensorSampledAt:number;}
export function gpuObservation(csv:string):{gpuPercent:number|null;gpuTemperatureC:number|null;gpuName:string}{
 const rows=csv.trim().split(/\r?\n/).filter(Boolean).map(row=>row.split(',').map(x=>x.trim()));
 const number=(v:string,max:number):number|null=>v!==''&&Number.isFinite(Number(v))&&Number(v)>=0&&Number(v)<=max?Number(v):null;
 const loads=rows.map(r=>number(r[1]??'',100)).filter((v):v is number=>v!==null),temps=rows.map(r=>number(r[2]??'',150)).filter((v):v is number=>v!==null);
 return {gpuName:rows.map(r=>r[0]).join(' / ').slice(0,200),gpuPercent:loads.length?Math.max(...loads):null,gpuTemperatureC:temps.length?Math.max(...temps):null};
}
/** Observation only. Slow hardware probes never block dispatch or resource admission. */
export class DeviceTelemetryPublisher {
 private pending=false;private next=0;private sensorNext=0;private sensorPending=false;
 private last=os.cpus();private sensors={batteryPercent:null as number|null,powerStatus:'UNKNOWN',sampledAt:0};
 constructor(private send:(body:DeviceTelemetry)=>Promise<unknown>,private hasGpu:boolean){}
 tick(offset:number):void{if(this.pending||Date.now()<this.next)return;this.pending=true;this.next=Date.now()+3000;
  void this.collect(offset).catch(()=>{this.next=Date.now()+30000;}).finally(()=>{this.pending=false;});
 }
 private async collect(offset:number):Promise<void>{
  const now=Date.now(),current=os.cpus();let idle=0,total=0;
  current.forEach((c,i)=>{const p=this.last[i];if(!p)return;idle+=c.times.idle-p.times.idle;for(const k of ['user','nice','sys','idle','irq'] as const)total+=c.times[k]-p.times[k];});this.last=current;
  if(process.platform==='win32'&&!this.sensorPending&&now>=this.sensorNext){this.sensorPending=true;this.sensorNext=now+30000;
   void run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$b=@(Get-CimInstance Win32_Battery -ErrorAction Stop); if($b.Count -eq 0){'{\"powerStatus\":\"NO_BATTERY\",\"batteryPercent\":null}'}else{$v=$b[0]; @{batteryPercent=$v.EstimatedChargeRemaining;powerStatus=$(if($v.BatteryStatus -in @(6,7,8,9)){'CHARGING'}elseif($v.BatteryStatus -eq 1){'DISCHARGING'}elseif($v.BatteryStatus -in @(2,3)){'AC_POWER'}else{'UNKNOWN'})}|ConvertTo-Json -Compress}"],{windowsHide:true,timeout:5000,maxBuffer:4096}).then(r=>{const v=JSON.parse(r.stdout);this.sensors={batteryPercent:typeof v.batteryPercent==='number'&&v.batteryPercent>=0&&v.batteryPercent<=100?v.batteryPercent:null,powerStatus:['NO_BATTERY','CHARGING','DISCHARGING','AC_POWER','UNKNOWN'].includes(v.powerStatus)?v.powerStatus:'UNKNOWN',sampledAt:Date.now()};}).catch(()=>{this.sensors={batteryPercent:null,powerStatus:'UNKNOWN',sampledAt:Date.now()};}).finally(()=>{this.sensorPending=false;});
  }
  let gpu={gpuPercent:null as number|null,gpuTemperatureC:null as number|null,gpuName:''};
  if(this.hasGpu)try{gpu=gpuObservation((await run('nvidia-smi',['--query-gpu=name,utilization.gpu,temperature.gpu','--format=csv,noheader,nounits'],{windowsHide:true,timeout:2000,maxBuffer:4096})).stdout);}catch{}
  const fresh=now-this.sensors.sampledAt<60000;
  await this.send({sampledAt:Date.now()+offset,cpuPercent:total>0?Math.max(0,Math.min(100,100*(1-idle/total))):null,memoryUsedBytes:os.totalmem()-os.freemem(),memoryTotalBytes:os.totalmem(),batteryPercent:fresh?this.sensors.batteryPercent:null,powerStatus:fresh?this.sensors.powerStatus:'UNKNOWN',sensorSampledAt:fresh?this.sensors.sampledAt+offset:0,...gpu});
 }
}
