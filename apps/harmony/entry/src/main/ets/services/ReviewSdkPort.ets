import {HarmonySdkPort,SdkPort,SdkTicket,SdkClock,SdkStatus,SdkInput} from 'scheduler';
/** Observes the SDK's existing status polling; never adds a dispatch path. */
export class ReviewSdkPort implements SdkPort{
 private base:HarmonySdkPort;
 listener:((status:SdkStatus)=>void)|null=null;
 constructor(base:HarmonySdkPort){this.base=base;}
 async request(route:string,body:string|null):Promise<string>{const value=await this.base.request(route,body);if(body===null&&/^\/v2\/sdk\/jobs\/[^/]+$/.test(route)&&this.listener)this.listener(JSON.parse(value) as SdkStatus);return value;}
 write(ticket:SdkTicket,data:Uint8Array):Promise<void>{return this.base.write(ticket,data);}
 writeDirect(jobId:string,endpointId:string,ticket:SdkTicket,data:Uint8Array):Promise<void>{return this.base.writeDirect(jobId,endpointId,ticket,data);}
 stageInput(input:SdkInput,data:Uint8Array):Promise<void>{if(!this.base.stageInput)throw Error('APP_HOST_REQUIRED');return this.base.stageInput(input,data);}
 read(ticket:SdkTicket):Promise<Uint8Array>{return this.base.read(ticket);}
 digest(data:Uint8Array):Promise<string>{return this.base.digest(data);}
 now():number{return this.base.now();}
 measure():SdkClock{return this.base.measure();}
 wait(ms:number):Promise<void>{return this.base.wait(ms);}
}
