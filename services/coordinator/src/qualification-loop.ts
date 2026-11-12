import { Peer } from './channel';
import { QualificationService } from './qualification';

export interface QualificationTarget {peer:Peer;targetId:string;}
export interface QualificationLoopPorts {
  targets():Promise<QualificationTarget[]>;
  refresh(groupId:string):Promise<unknown>;
  onError(error:unknown):void;
}
/** Host-driven bounded calibration cadence. Authorization and physical resource gates remain in the service. */
export class QualificationLoop {
  private stopped=true;
  private timer:NodeJS.Timeout|undefined;
  private pending:Promise<void>|undefined;
  private cursor=0;
  private readonly deviceCursors=new Map<string,number>();
  private readonly lanes=new Map<string,Promise<void>>();
  private readonly continuing=new Map<string,Set<string>>();
  private readonly nextCheck=new Map<string,number>();
  private wake:NodeJS.Timeout|undefined;
  constructor(private readonly service:Pick<QualificationService,'advance'>,private readonly ports:QualificationLoopPorts,
    private readonly intervalMs=1000,private readonly maxPerTick=8,private readonly maxConcurrent=4){
    if(!Number.isSafeInteger(intervalMs)||intervalMs<100||!Number.isSafeInteger(maxPerTick)||maxPerTick<1||maxPerTick>128)throw Error('CALIBRATION_LOOP_CONFIG');
    if(!Number.isSafeInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>16)throw Error('CALIBRATION_LOOP_CONFIG');
  }
  start(){
    if(!this.stopped)throw Error('CALIBRATION_LOOP_STARTED');this.stopped=false;
    const trigger=()=>{void this.tick().catch(this.ports.onError);};
    this.timer=setInterval(trigger,this.intervalMs);this.timer.unref();trigger();
  }
  tick():Promise<void>{
    if(this.stopped)return Promise.resolve();
    if(!this.pending)this.pending=this.step().finally(()=>{this.pending=undefined;});
    return this.pending;
  }
  private async step(){
    const raw=await this.ports.targets();
    const targets=[...new Map(raw.map(t=>[JSON.stringify([t.peer.groupId,t.peer.holderInstanceId,t.targetId]),t])).values()];
    const presentChecks=new Set(targets.map(t=>JSON.stringify([t.peer.groupId,t.peer.holderInstanceId,t.targetId])));
    for(const id of this.nextCheck.keys())if(!presentChecks.has(id))this.nextCheck.delete(id);
    for(const [key,unfinished] of this.continuing){
      const present=new Set(targets.filter(t=>JSON.stringify([t.peer.groupId,t.peer.deviceId??t.peer.holderInstanceId])===key).map(t=>JSON.stringify([t.peer.holderInstanceId,t.targetId])));
      for(const id of unfinished)if(!present.has(id))unfinished.delete(id);
      if(!unfinished.size)this.continuing.delete(key);
    }
    if(!targets.length){this.cursor=0;return;}
    const groups=new Map<string,QualificationTarget[]>();
    for(const target of targets){const key=JSON.stringify([target.peer.groupId,target.peer.deviceId??target.peer.holderInstanceId]);groups.set(key,[...(groups.get(key)??[]),target]);}
    for(const key of this.deviceCursors.keys())if(!groups.has(key))this.deviceCursors.delete(key);
    const devices=[...groups];let launched=0;
    for(let n=0;n<devices.length&&launched<this.maxPerTick&&!this.stopped&&this.lanes.size<this.maxConcurrent;n++){
      const [key,choices]=devices[this.cursor%devices.length];this.cursor=(this.cursor+1)%devices.length;
      // Device Apps share physical resources. Serialize within a device, while a
      // slow/unavailable device must not hold up another device's first join.
      if(this.lanes.has(key))continue;
      launched++;
      const task=Promise.resolve().then(async()=>{
        const unfinished=this.continuing.get(key)??new Set<string>();
        // An inactive owner may advertise dozens of unrelated targets. Walking
        // past them must not cost one timer tick per target before reaching the
        // foreground photo App. At most one full rotation, still one lane/device.
        let changed=false;
        for(let scanned=0;scanned<choices.length&&!this.stopped;scanned++){
          const at=this.deviceCursors.get(key)??0,target=choices[at%choices.length];this.deviceCursors.set(key,(at+1)%choices.length);
          const checkKey=JSON.stringify([target.peer.groupId,target.peer.holderInstanceId,target.targetId]);
          if((this.nextCheck.get(checkKey)??0)>Date.now())continue;
          let state:string|undefined;
          try{state=await this.service.advance(target.peer,target.targetId);changed=true;}catch(error){this.ports.onError(error);}
          const targetKey=JSON.stringify([target.peer.holderInstanceId,target.targetId]);
          if(state==='CALIBRATING'){unfinished.add(targetKey);this.nextCheck.delete(checkKey);break;}
          unfinished.delete(targetKey);
          // Avoid turning completed evidence / blocked targets into a hot DB loop.
          this.nextCheck.set(checkKey,Date.now()+(state==='ACTIVE'?Math.max(5000,this.intervalMs):this.intervalMs));
        }
        if(changed)try{await this.ports.refresh(choices[0].peer.groupId);}catch(error){this.ports.onError(error);}
        if(unfinished.size)this.continuing.set(key,unfinished);else this.continuing.delete(key);
        this.lanes.delete(key);
        // Continue an unfinished suite without a one-second gap per case. Other
        // targets still rotate fairly; ACTIVE/wait/error never create a hot loop.
        if(!this.stopped&&unfinished.size&&!this.wake){this.wake=setTimeout(()=>{this.wake=undefined;void this.tick().catch(this.ports.onError);},0);this.wake.unref();}
      });
      this.lanes.set(key,task);
    }
  }
  async close(){this.stopped=true;if(this.timer)clearInterval(this.timer);if(this.wake)clearTimeout(this.wake);await this.pending?.catch(()=>{});await Promise.allSettled(this.lanes.values());}
}
