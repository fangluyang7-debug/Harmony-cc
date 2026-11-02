import https from 'node:https';
import {performance} from 'node:perf_hooks';
import {networkInterfaces} from 'node:os';
import {canonical} from '@harmony/scheduler-core';
import {DataEndpointIdentity,pinOptions,validDataEndpoint} from '@harmony/resource-transport';
import {ControlRequest} from './allotment-client';

export class PeerLinks {
  private network='';private epoch='';private measuredAt=0;
  private stopped=false;
  constructor(private readonly deviceId:string,private readonly request:ControlRequest,private readonly networkState=()=>canonical(networkInterfaces())){}
  invalidate(){this.epoch='';this.measuredAt=0;}
  close(){this.stopped=true;this.invalidate();}
  async sample(){
    if(this.stopped)return;
    const network=this.networkState();
    if(network!==this.network){this.network=network;this.invalidate();}
    if(!this.epoch)this.epoch=(await this.request('/v2/data/network/reset',{} ) as {epoch:string}).epoch;
    if(Date.now()-this.measuredAt<20000)return;
    const epoch=this.epoch,endpoints=await this.request('/v2/data/endpoints',{}) as DataEndpointIdentity[];
    if(!Array.isArray(endpoints)||endpoints.length>64||!endpoints.every(validDataEndpoint))throw Error('ENDPOINT_DIRECTORY_INVALID');
    for(const endpoint of endpoints.filter(e=>e.deviceId!==this.deviceId))for(const direction of ['READ','WRITE']){
      if(this.stopped)return;
      const samples:{bytes:number;durationMs:number}[]=[];let reason='REACHABLE';
      try{for(const bytes of [1024,8192,32768])samples.push({bytes,durationMs:await this.probe(endpoint,direction,bytes)});}
      catch(error){samples.length=0;const code=(error as NodeJS.ErrnoException).code??(error as Error).message;
        reason=/CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)?'TLS_MISMATCH':/TIMEOUT|TIMEDOUT/.test(code)?'TIMEOUT':'PEER_UNREACHABLE';}
      if(this.stopped||network!==this.networkState()||epoch!==this.epoch){this.invalidate();return;}
      await this.request('/v2/data/network/report',{epoch,endpointId:endpoint.id,endpointEpoch:endpoint.epoch,direction,reason,samples});
    }
    this.measuredAt=Date.now();
  }
  private probe(endpoint:DataEndpointIdentity,direction:string,bytes:number){
    const started=performance.now();return new Promise<number>((resolve,reject)=>{
      const request=https.request(new URL('/v2/direct/probe?bytes='+bytes,endpoint.address),{...pinOptions(endpoint),method:direction==='READ'?'GET':'PUT',headers:direction==='WRITE'?{'Content-Length':bytes}:{}},response=>{
        let size=0;response.on('data',chunk=>{size+=chunk.length;if(size>bytes)request.destroy(Error('PROBE_SIZE'));});response.on('error',reject);
        response.on('end',()=>response.statusCode===200&&response.headers['x-endpoint-epoch']===endpoint.epoch&&size===(direction==='READ'?bytes:0)?resolve(performance.now()-started):reject(Error('PROBE_INVALID')));
      });
      const timer=setTimeout(()=>request.destroy(Error('PROBE_TIMEOUT')),3000);timer.unref();request.on('close',()=>clearTimeout(timer));request.on('error',reject);request.end(direction==='WRITE'?Buffer.alloc(bytes):undefined);
    });
  }
}
