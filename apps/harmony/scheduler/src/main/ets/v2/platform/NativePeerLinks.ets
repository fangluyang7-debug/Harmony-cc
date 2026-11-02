import {common} from '@kit.AbilityKit';
import {connection,http} from '@kit.NetworkKit';
import {NativeTransport,TrustedCoordinator,monotonic} from './NativeTransport';
import {NativeDataEndpoint} from './NativeTransferGrant';
interface NetworkGeneration {epoch:string;}
interface PeerSample {bytes:number;durationMs:number;}
interface PeerReport {epoch:string;endpointId:string;endpointEpoch:string;direction:string;reason:string;samples:PeerSample[];}
/** Phone probes are outbound only. Local network events invalidate in-flight measurements. */
export class NativePeerLinks {
 private epoch='';private generation=0;private measuredAt=0;private pending:Promise<void>|null=null;private stopped=false;
 private monitor:connection.NetConnection|null=null;
 private context:common.UIAbilityContext;
 private coordinator:NativeTransport;
 private deviceId:string;
 constructor(context:common.UIAbilityContext,coordinator:NativeTransport,deviceId:string){this.context=context;this.coordinator=coordinator;this.deviceId=deviceId;}
 start():void{
  this.monitor=connection.createNetConnection();
  this.monitor.on('netAvailable',()=>this.invalidate());this.monitor.on('netLost',()=>this.invalidate());
  this.monitor.on('netCapabilitiesChange',()=>this.invalidate());
  this.monitor.register((error)=>{if(error)this.invalidate();});
 }
 invalidate():void{this.generation++;this.epoch='';this.measuredAt=0;}
 sample():Promise<void>{
  if(this.stopped)return Promise.resolve();if(this.pending!==null)return this.pending;
  this.pending=this.measure().finally(()=>{this.pending=null;});return this.pending;
 }
 private async measure():Promise<void>{
  const generation=this.generation;
  if(this.epoch===''){
   const next=await this.coordinator.json('/v2/data/network/reset',{} as Record<string,Object>) as NetworkGeneration;
   if(generation!==this.generation||this.stopped)return;this.epoch=next.epoch;
  }
  if(monotonic()-this.measuredAt<20000)return;
  const endpoints=await this.coordinator.json('/v2/data/endpoints') as NativeDataEndpoint[];
  if(!Array.isArray(endpoints)||endpoints.length>64)throw Error('ENDPOINT_DIRECTORY_INVALID');
  for(const endpoint of endpoints){
   if(endpoint.deviceId===this.deviceId)continue;
   for(const direction of ['READ','WRITE']){
    if(this.stopped||generation!==this.generation)return;
    const samples:PeerSample[]=[];let reason='REACHABLE';
    try{
     const trust:TrustedCoordinator={address:endpoint.address,certificate:endpoint.certificate,fingerprint:endpoint.fingerprint};
     const peer=new NativeTransport(trust,this.context);await peer.initialize();
     for(const count of [1024,8192,32768]){
      const header:Record<string,string>={'Content-Type':'application/octet-stream'};if(direction==='WRITE')header['Content-Length']=String(count);
      const start=monotonic(),data=await peer.request('/v2/direct/probe?bytes='+count,null,direction==='READ'?http.RequestMethod.GET:http.RequestMethod.PUT,header,direction==='WRITE'?new Uint8Array(count):null);
      if(peer.endpointEpoch!==endpoint.epoch||data.length!==(direction==='READ'?count:0))throw Error('PROBE_INVALID');
      samples.push({bytes:count,durationMs:Math.max(1,monotonic()-start)});
     }
    }catch(e){samples.length=0;const message=(e as Error).message;reason=/TLS|CERTIFICATE/.test(message)?'TLS_MISMATCH':/TIMEOUT/.test(message)?'TIMEOUT':'PEER_UNREACHABLE';}
    if(this.stopped||generation!==this.generation)return;
    const report:PeerReport={epoch:this.epoch,endpointId:endpoint.id,endpointEpoch:endpoint.epoch,direction,reason,samples};
    await this.coordinator.json('/v2/data/network/report',report);
   }
  }
  this.measuredAt=monotonic();
 }
 async close():Promise<void>{this.stopped=true;this.invalidate();this.monitor?.unregister(()=>{});await this.pending;}
}
