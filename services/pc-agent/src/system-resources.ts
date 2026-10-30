import os from 'node:os';
import { execFile } from 'node:child_process';
import { ResourceAmountV2 } from '@harmony/scheduler-core';

export interface SystemResources {cpuThreads:number;totalMemoryBytes:number;freeMemoryBytes:number;sampledAt:number;}
export function collectSystemResources():SystemResources {
  return {cpuThreads:os.availableParallelism(),totalMemoryBytes:os.totalmem(),freeMemoryBytes:os.freemem(),sampledAt:Date.now()};
}
/** This signal reveals only keyboard/mouse idle duration in the process's Windows session. */
export async function windowsOwnerActivity(idleThresholdMs:number):Promise<'IDLE'|'ACTIVE'|'UNKNOWN'> {
  if(!Number.isSafeInteger(idleThresholdMs)||idleThresholdMs<1000)throw Error('IDLE_THRESHOLD_INVALID');
  if(process.platform!=='win32')return 'UNKNOWN';
  const script=`Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HarmonyInput {
 [StructLayout(LayoutKind.Sequential)] public struct Input { public uint size; public uint time; }
 [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref Input input);
 public static uint Idle() { Input input=new Input(); input.size=(uint)Marshal.SizeOf(input); if(!GetLastInputInfo(ref input))throw new Exception(); return unchecked((uint)Environment.TickCount-input.time); }
}
'@
[HarmonyInput]::Idle()`;
  return new Promise(resolve=>{
    execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:5000,maxBuffer:4096},(error,stdout)=>{
      const value=stdout.trim();
      if(error||!/^\d+$/.test(value)){resolve('UNKNOWN');return;}
      resolve(Number(value)>=idleThresholdMs?'IDLE':'ACTIVE');
    });
  });
}
export interface ResourceMonitorPorts {
  sample():Promise<SystemResources>;
  owner():Promise<'IDLE'|'ACTIVE'|'UNKNOWN'>;
  occupied():ResourceAmountV2[];
  update(limits:ResourceAmountV2[],owner:'IDLE'|'ACTIVE'|'UNKNOWN'):Promise<void>;
  onError(error:unknown):void;
}
export interface ResourceMonitorPolicy {cpuPoolId:string;memoryPoolId:string;maxCpuThreads:number;maxMemoryBytes:number;reserveMemoryBytes:number;}
/** Local availability constrains the owner's configured ceiling; it never grants coordinator quota. */
export class ResourceMonitor {
  private timer:NodeJS.Timeout|undefined;private pending:Promise<void>|undefined;private stopped=false;
  constructor(private readonly policy:ResourceMonitorPolicy,private readonly ports:ResourceMonitorPorts){
    if(!policy.cpuPoolId||!policy.memoryPoolId||policy.cpuPoolId===policy.memoryPoolId||
      [policy.maxCpuThreads,policy.maxMemoryBytes,policy.reserveMemoryBytes].some(v=>!Number.isSafeInteger(v)||v<0))throw Error('RESOURCE_MONITOR_POLICY');
  }
  sample():Promise<void>{
    if(this.stopped)return Promise.resolve();
    if(!this.pending)this.pending=this.collect().finally(()=>{this.pending=undefined;});return this.pending;
  }
  private async collect(){
    let deadline:NodeJS.Timeout|undefined;
    try{
      const [sample,owner]=await Promise.race([Promise.all([this.ports.sample(),this.ports.owner()]),new Promise<never>((_,reject)=>{
        deadline=setTimeout(()=>reject(Error('SYSTEM_SAMPLE_TIMEOUT')),6000);
      })]);
      if(this.stopped)return;
      if(!['IDLE','ACTIVE','UNKNOWN'].includes(owner)||[sample.cpuThreads,sample.totalMemoryBytes,sample.freeMemoryBytes,sample.sampledAt].some(v=>!Number.isSafeInteger(v)||v<0)||
        sample.freeMemoryBytes>sample.totalMemoryBytes||sample.sampledAt>Date.now()||Date.now()-sample.sampledAt>10000)throw Error('SYSTEM_SAMPLE_INVALID');
      const ownMemory=this.ports.occupied().find(r=>r.resourcePoolId===this.policy.memoryPoolId)?.amount??0;
      if(!Number.isSafeInteger(ownMemory)||ownMemory<0)throw Error('OCCUPANCY_INVALID');
      // Admission limits include outstanding work: free RAM is additional headroom, not the total ledger limit.
      const memory=Math.min(this.policy.maxMemoryBytes,sample.totalMemoryBytes,ownMemory+Math.max(0,sample.freeMemoryBytes-this.policy.reserveMemoryBytes));
      await this.ports.update([{resourcePoolId:this.policy.cpuPoolId,amount:Math.min(this.policy.maxCpuThreads,sample.cpuThreads)},
        {resourcePoolId:this.policy.memoryPoolId,amount:memory}],owner);
    }catch(error){if(!this.stopped)await this.ports.update([],'UNKNOWN');this.ports.onError(error);}
    finally{if(deadline)clearTimeout(deadline);}
  }
  start(intervalMs=2000){
    if(this.stopped||this.timer||!Number.isSafeInteger(intervalMs)||intervalMs<100)throw Error('MONITOR_START_INVALID');
    const tick=()=>{void this.sample().catch(this.ports.onError);};this.timer=setInterval(tick,intervalMs);this.timer.unref();tick();
  }
  async close(){this.stopped=true;if(this.timer)clearInterval(this.timer);await this.pending?.catch(()=>{});}
}
