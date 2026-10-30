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
  constructor(private readonly service:Pick<QualificationService,'advance'>,private readonly ports:QualificationLoopPorts,
    private readonly intervalMs=1000,private readonly maxPerTick=8){
    if(!Number.isSafeInteger(intervalMs)||intervalMs<100||!Number.isSafeInteger(maxPerTick)||maxPerTick<1||maxPerTick>128)throw Error('CALIBRATION_LOOP_CONFIG');
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
    if(!targets.length){this.cursor=0;return;}
    const count=Math.min(targets.length,this.maxPerTick);
    for(let n=0;n<count&&!this.stopped;n++){
      const target=targets[this.cursor%targets.length];this.cursor=(this.cursor+1)%targets.length;
      try{await this.service.advance(target.peer,target.targetId);}
      catch(error){this.ports.onError(error);}
      // Refresh even after a failed evaluation: evidence may have been suspended before the runner failed.
      try{await this.ports.refresh(target.peer.groupId);}catch(error){this.ports.onError(error);}
    }
  }
  async close(){this.stopped=true;if(this.timer)clearInterval(this.timer);await this.pending?.catch(()=>{});}
}
