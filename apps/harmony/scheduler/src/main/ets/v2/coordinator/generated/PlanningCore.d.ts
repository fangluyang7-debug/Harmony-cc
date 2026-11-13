export interface NativePhotoPort {call(operation:string,payload:string):Promise<string>;id():string;now():number;}
export declare class NativePhotoEngine {constructor(port:NativePhotoPort);restore():Promise<void>;tick():Promise<void>;sdk(peer:string,path:string,body:string):Promise<string>;photo(peer:string,input:string):Promise<string>;graphs(id:string):Promise<boolean>;views():Promise<string>;record(key:string):Promise<string>;display(path:string,body:string,key:string,address:string,devices:string):Promise<string>;}
export declare function nativePlanJson(profiles:string,evidence:string,request:string,now:number,monotonic:()=>number):string;
export declare function planJson(snapshot:string,request:string,policy:string,now:number,monotonic:()=>number):string;
export declare function availabilityJson(profile:string,executor:string,priority:string,version:number,now:number):string;
