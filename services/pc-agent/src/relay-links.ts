import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { performance } from 'node:perf_hooks';
import { canonical, LinkV2, protocolId } from '@harmony/scheduler-core';
import { DirectionalLinks } from '@harmony/resource-transport';
import { ControlRequest } from './allotment-client';

/** Measured full HTTP request intervals, including control overhead; not raw one-way bandwidth. */
export class RelayLinks {
  private network='';private epoch=randomUUID();private links:LinkV2[]=[];private measuredAt=0;
  constructor(private readonly deviceId:string,private readonly domain:'REAL'|'SIMULATED',private readonly request:ControlRequest,
    private readonly networkState=()=>canonical(networkInterfaces())){}
  get state(){return this.links.length?'MEASURED':'UNKNOWN';}
  async sample(now:number,network=this.networkState()){
    if(network!==this.network){this.network=network;this.epoch=randomUUID();this.links=[];this.measuredAt=0;}
    if(this.measuredAt&&now>=this.measuredAt&&now-this.measuredAt<20000)return structuredClone(this.links);
    const measured=new DirectionalLinks(this.domain);let relayId='';
    try{
      for(const mode of ['upload','download'])for(const bytes of [1024,8192,32768]){
        const start=performance.now(),reply=await this.request('/v2/link-probe',{mode,bytes,...(mode==='upload'?{padding:'x'.repeat(bytes)}:{})}) as {relayId:string;padding:string};
        const durationMs=performance.now()-start;
        if(!protocolId(reply.relayId)||relayId&&relayId!==reply.relayId||reply.padding!==(mode==='download'?'x'.repeat(bytes):''))throw Error('LINK_PROBE_INVALID');
        relayId=reply.relayId;
        measured.observe(mode==='upload'?this.deviceId:relayId,mode==='upload'?relayId:this.deviceId,this.epoch,this.epoch,this.domain,{bytes,durationMs,observedAt:now});
      }
      // Discard a probe batch if the local network changed while it was in flight.
      if(network!==this.networkState()){this.links=[];return [];}
      this.links=[['upload',this.deviceId,relayId],['download',relayId,this.deviceId]].flatMap(([,from,to])=>{
        const estimate=measured.estimate(from,to,this.epoch,now,30000);if(!estimate)return [];
        const numeric=(value:number,unit:string)=>({value,unit,source:this.domain==='REAL'?'MEASURED':'SIMULATED',sampledAt:now,ttlMs:30000});
        // OS metering is unavailable here: conservatively treat it as metered.
        return [{from,to,networkEpoch:this.epoch,via:null,metered:true,fixedMs:numeric(estimate.fixedMs,'ms'),bytesPerSecond:numeric(estimate.bytesPerSecond,'bytes_per_second')}];
      });this.measuredAt=now;
    }catch{this.links=[];this.measuredAt=0;}
    return structuredClone(this.links);
  }
}
