import { DeviceProfileV2, validDeviceProfileV2 } from '@harmony/scheduler-core';

export interface ProfileSource {
  collect():Promise<Omit<DeviceProfileV2,'sequence'>>;
  subscribe(changed:()=>void):()=>void;
}
export interface ProfilePublisherPorts {
  source:ProfileSource;
  // The host persists this sequence BEFORE the profile can leave the process.
  nextSequence():Promise<number>;
  // B6 supplies the authenticated, bounded transport; resolution means the peer ACKed.
  publish(profile:DeviceProfileV2):Promise<void>;
  onError(error:unknown):void;
  every?(milliseconds:number,callback:()=>void):()=>void;
}

/** Platform-neutral source adapter, with a bounded single-flight event/heartbeat sender. */
export class ProfilePublisher {
  private active=false;
  private dirty=false;
  private pending:Promise<void>|undefined;
  private unsubscribe:(()=>void)|undefined;
  private cancelTimer:(()=>void)|undefined;
  constructor(private readonly ports:ProfilePublisherPorts,private readonly heartbeatMs=1000){
    if(!Number.isSafeInteger(heartbeatMs)||heartbeatMs<100||heartbeatMs>60000)throw Error('HEARTBEAT_INVALID');
  }
  async start():Promise<void>{
    if(this.active)throw Error('PUBLISHER_ALREADY_STARTED');
    this.active=true;
    const trigger=()=>{void this.changed().catch(error=>this.ports.onError(error));};
    this.unsubscribe=this.ports.source.subscribe(trigger);
    const every=this.ports.every??((ms,callback)=>{const timer=setInterval(callback,ms);timer.unref();return ()=>clearInterval(timer);});
    this.cancelTimer=every(this.heartbeatMs,trigger);
    try{await this.changed();}catch(error){await this.stop();throw error;}
  }
  changed():Promise<void>{
    if(!this.active)return Promise.resolve();
    this.dirty=true;
    if(!this.pending)this.pending=this.drain().finally(()=>{this.pending=undefined;});
    return this.pending;
  }
  private async drain(){
    while(this.active&&this.dirty){
      this.dirty=false;
      const collected=await this.ports.source.collect();
      if(!this.active)return;
      // Never refresh sampledAt/ttlMs just because a heartbeat was sent.
      const profile={...collected,sequence:await this.ports.nextSequence()};
      if(!validDeviceProfileV2(profile))throw Error('PROFILE_INVALID');
      if(this.active)await this.ports.publish(profile);
    }
  }
  async stop():Promise<void>{
    this.active=false;this.dirty=false;
    this.unsubscribe?.();this.cancelTimer?.();
    this.unsubscribe=undefined;this.cancelTimer=undefined;
    await this.pending?.catch(()=>{});
  }
}
