import { common } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { NativeTransport, TrustedCoordinator, bytes, text, hash } from '../platform/NativeTransport';
import { SdkPort, SdkTicket } from './SchedulerSdk';
interface AppExchange {credential:string;}
interface AppCode {registrationId:string;code:string;}
/** Native adapter shared by SDK consumers. It has no dependency on agent or its journal. */
export class HarmonySdkPort implements SdkPort {
 private transport:NativeTransport;
 private constructor(transport:NativeTransport){this.transport=transport;}
 static async open(context:common.UIAbilityContext,trust:TrustedCoordinator,credential:string=''):Promise<HarmonySdkPort>{
  const transport=new NativeTransport(trust,context);await transport.initialize();transport.credential=credential;return new HarmonySdkPort(transport);
 }
 async exchange(registrationId:string,code:string):Promise<string>{
  const body:AppCode={registrationId,code},result=text(await this.transport.request('/v2/apps/exchange',body)),exchange=JSON.parse(result) as AppExchange;
  if(!/^[A-Za-z0-9_-]{43}$/.test(exchange.credential))throw Error('SDK_CREDENTIAL_INVALID');this.transport.credential=exchange.credential;return result;
 }
 async request(route:string,body:string|null):Promise<string>{return text(await this.transport.request(route,body===null?null:JSON.parse(body) as Object));}
 private route(ticket:SdkTicket):string{if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(ticket.ref.artifactId)||ticket.ref.contentVersion!==1)throw Error('SDK_TICKET_INVALID');return '/v2/artifacts/'+ticket.ref.artifactId+'/'+ticket.ref.contentVersion;}
 private headers(ticket:SdkTicket):Record<string,string>{return {'Authorization':'Bearer '+ticket.token,'X-Device-Credential':this.transport.credential,'Content-Type':'application/octet-stream'};}
 async write(ticket:SdkTicket,data:Uint8Array):Promise<void>{
  if(ticket.operation!=='WRITE'||data.byteLength!==ticket.bytes||hash(data)!==ticket.ref.contentHash)throw Error('SDK_INPUT_INTEGRITY');
  await this.transport.request(this.route(ticket),null,http.RequestMethod.PUT,this.headers(ticket),data.slice());
 }
 async read(ticket:SdkTicket):Promise<Uint8Array>{if(ticket.operation!=='READ')throw Error('SDK_TICKET_INVALID');return this.transport.request(this.route(ticket),null,http.RequestMethod.GET,this.headers(ticket));}
 async digest(data:Uint8Array):Promise<string>{return hash(data);}
 now():number{return Date.now();}
 async wait(ms:number):Promise<void>{await new Promise<void>(resolve=>{setTimeout(resolve,ms);});}
}
