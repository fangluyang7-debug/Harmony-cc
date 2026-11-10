import { common } from '@kit.AbilityKit';
import { NativeDatabase, Installation, hash } from './NativePlatform';
export interface ConsoleConnection { address:string; groupId:string; fingerprint:string; }
export function consoleOrigin(value:string):string {
 const address=value.trim().replace(/\/$/,'');
 if(!/^https:\/\/[A-Za-z0-9.:-]+$/.test(address))throw Error('请填写 HTTPS 协调中心地址，例如 https://192.168.1.10:7443');
 return address;
}
// Expose public connection information only; device credentials remain native.
export async function consoleConnection(context:common.UIAbilityContext):Promise<ConsoleConnection|null>{
 const db=await NativeDatabase.open(context),saved=await db.get('identity');
 if(saved!==null){const installation=JSON.parse(saved) as Installation;return {address:consoleOrigin(installation.bootstrap.invitation.address),groupId:installation.paired.peer.groupId,fingerprint:installation.bootstrap.invitation.fingerprint};}
 const address=await db.get('console-address');
 const pin=await db.get('console-pin');
 return address===null?null:{address:consoleOrigin(address),groupId:'',fingerprint:pin??''};
}
export async function saveConsoleAddress(context:common.UIAbilityContext,value:string):Promise<void>{
 const db=await NativeDatabase.open(context);await db.put('console-address',consoleOrigin(value));
 await db.put('console-pin','');
}
export async function saveInvitedConsole(context:common.UIAbilityContext,connection:ConsoleConnection):Promise<void>{
 const db=await NativeDatabase.open(context);await db.put('console-address',connection.address);await db.put('console-pin',connection.fingerprint);
}
export function belongsToConsole(connection:ConsoleConnection,url:string):boolean {
 return url===connection.address||url.startsWith(connection.address+'/');
}
export function matchesConsoleCertificate(connection:ConsoleConnection,url:string,certificate:Uint8Array):boolean {
 return belongsToConsole(connection,url)&&/^[a-f0-9]{64}$/.test(connection.fingerprint)&&hash(certificate)===connection.fingerprint;
}
