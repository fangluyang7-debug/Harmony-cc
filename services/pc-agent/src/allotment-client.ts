import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { AllotmentGrantV2, ResourceAmountV2, validResourceVectorV2 } from '@harmony/scheduler-core';
import { DurableLedger } from './durable-ledger';
import { pinned, RecoveryConnection } from './recovery-client';

export interface AllotmentPolicy { base:ResourceAmountV2[];extra:ResourceAmountV2[];leaseMs:number; }
export type ControlRequest=(route:string,body:unknown)=>Promise<unknown>;

/** Bounded authenticated control requests; trust is established by pairing, never by the response. */
export function allotmentTransport(connection:RecoveryConnection):ControlRequest {
  return (route,body)=>new Promise((resolve,reject)=>{
    const read=/^\/v2\/qualification\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(route);
    if(!read&&!['/v2/allotments/request','/v2/allotments/ack'].includes(route)){reject(Error('CONTROL_ROUTE_INVALID'));return;}
    const data=Buffer.from(JSON.stringify(body));
    const request=https.request(new URL(route,connection.address),{...pinned(connection),method:read?'GET':'POST',headers:{
      Authorization:'Bearer '+connection.credential,'Content-Type':'application/json','Content-Length':read?0:data.length
    }},response=>{
      const chunks:Buffer[]=[];let size=0;
      response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>262144)request.destroy(Error('CONTROL_RESPONSE_TOO_LARGE'));else chunks.push(chunk);});
      response.on('error',reject);
      response.on('end',()=>{try{
        if(response.statusCode!==200&&response.statusCode!==201)throw Error('CONTROL_REQUEST_REJECTED');
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      }catch(error){reject(error);}});
    });
    const deadline=setTimeout(()=>request.destroy(Error('CONTROL_TIMEOUT')),10000);
    request.once('close',()=>clearTimeout(deadline));
    request.setTimeout(10000,()=>request.destroy(Error('CONTROL_TIMEOUT')));
    request.on('error',reject);request.end(read?undefined:data);
  });
}

/** One renewal at a time. Only a verified, persisted grant changes the local lease. */
export class AllotmentClient {
  private pending:Promise<void>|undefined;
  private timer:NodeJS.Timeout|undefined;
  private stopped=false;
  constructor(private readonly ledger:DurableLedger,private readonly credential:string,
    private readonly request:ControlRequest,private readonly policy:()=>AllotmentPolicy,
    private readonly onError:(error:unknown)=>void){}

  renew():Promise<void>{
    if(this.stopped)return Promise.reject(Error('ALLOTMENT_CLIENT_STOPPED'));
    if(this.pending)return this.pending;
    this.pending=this.exchange().finally(()=>{this.pending=undefined;});return this.pending;
  }
  private async exchange(){
    const policy=structuredClone(this.policy());
    if(!validResourceVectorV2(policy.base)||!validResourceVectorV2(policy.extra)||!Number.isSafeInteger(policy.leaseMs)||policy.leaseMs<1||policy.leaseMs>300000)throw Error('ALLOTMENT_POLICY_INVALID');
    // Persist the monotonic request origin before any network delay; retry never extends an old lease.
    const identity=this.ledger.requestGrant(randomUUID());
    const grant=await this.request('/v2/allotments/request',{...identity,...policy}) as AllotmentGrantV2;
    this.ledger.installGrant(grant);
    await this.acknowledge();
  }
  async acknowledge(){
    const signed=this.ledger.acknowledgement(this.credential);
    const reply=await this.request('/v2/allotments/ack',signed) as {acknowledged?:boolean};
    if(reply?.acknowledged!==true)throw Error('ALLOTMENT_ACK_REJECTED');
  }
  start(intervalMs:number){
    if(this.stopped||this.timer||!Number.isSafeInteger(intervalMs)||intervalMs<1)throw Error('ALLOTMENT_START_INVALID');
    const tick=()=>{void this.renew().catch(this.onError);};
    this.timer=setInterval(tick,intervalMs);this.timer.unref();tick();
  }
  async close(){
    this.stopped=true;if(this.timer)clearInterval(this.timer);
    await this.pending?.catch(()=>{});
  }
}
