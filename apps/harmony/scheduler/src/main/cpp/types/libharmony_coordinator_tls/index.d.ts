export interface TlsEvent {type:string;remoteAddress:string;clientId:number;requestId:number;data:ArrayBuffer;error:string;}
export const start:(certificate:string,privateKey:string,port:number,callback:(event:TlsEvent)=>void)=>void;
export const send:(clientId:number,data:ArrayBuffer,requestId:number)=>void;
export const closeClient:(clientId:number)=>void;
export const stop:()=>void;
