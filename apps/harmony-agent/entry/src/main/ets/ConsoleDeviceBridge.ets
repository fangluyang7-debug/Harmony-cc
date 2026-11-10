import {fileIo} from '@kit.CoreFileKit';
import {photoAccessHelper} from '@kit.MediaLibraryKit';
import {base64} from 'scheduler';
import { common } from '@kit.AbilityKit';
import { Bootstrap,NativeDatabase,Installation,factory } from './NativePlatform';
import { openAgent } from './AgentRuntime';
import { ConsoleConnection, belongsToConsole, consoleOrigin } from './ConsoleConnection';
import { scanJoinInvitation } from './JoinInvitation';
import { deviceInfo } from '@kit.BasicServicesKit';

// The trusted local console can pass its one-shot device invitation to the host.
// Persistent device credentials and the ledger never cross into the WebView.
export class ConsoleDeviceBridge {
 private context:()=>common.UIAbilityContext;
 private connection:()=>ConsoleConnection|null;
 private caller:()=>string;
 private paired:()=>Promise<void>;
 private installation:Promise<string>|null=null;
 constructor(context:()=>common.UIAbilityContext,connection:()=>ConsoleConnection|null,
  caller:()=>string,paired:()=>Promise<void>){this.context=context;this.connection=connection;this.caller=caller;this.paired=paired;}
 available():boolean{return true;}
 private async installationId():Promise<string>{const db=await NativeDatabase.open(this.context());let id=await db.get('device-installation-id');if(id===null){id=factory.id();await db.put('device-installation-id',id);}return id;}
 async info():Promise<string>{
  if(this.installation===null)this.installation=this.installationId();
  const installationId=await this.installation,db=await NativeDatabase.open(this.context()),saved=await db.get('identity');
  const identity:Installation|null=saved===null?null:JSON.parse(saved) as Installation;
  const knownDeviceIds=(await db.storedIdentities()).map((value:string)=>(JSON.parse(value) as Installation).paired.peer.deviceId);
  return JSON.stringify({installationId,knownDeviceIds,deviceId:identity?.paired.peer.deviceId??'',name:deviceInfo.deviceType==='phone'?'鸿蒙手机':'鸿蒙电脑',platform:'harmony',groupId:this.connection()?.groupId??''});
 }
 async pickPhoto():Promise<string>{
  const current=this.connection();if(current===null||!belongsToConsole(current,this.caller()))throw Error('CONSOLE_DEVICE_SCOPE');
  const picker=new photoAccessHelper.PhotoViewPicker(),selected=await picker.select({MIMEType:photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE,maxSelectNumber:1});
  if(selected.photoUris.length===0)return '{}';
  const file=fileIo.openSync(selected.photoUris[0],fileIo.OpenMode.READ_ONLY);
  try{const size=fileIo.statSync(file.fd).size;if(size<1||size>8388608)throw Error('PHOTO_INPUT_TOO_LARGE');const data=new ArrayBuffer(size);fileIo.readSync(file.fd,data);return JSON.stringify({name:'selected-photo.jpg',mime:'image/jpeg',data:base64.encodeToStringSync(new Uint8Array(data))});}finally{fileIo.closeSync(file);}
 }
 async scanInvite():Promise<string>{
  const current=this.connection();if(current===null||!belongsToConsole(current,this.caller()))throw Error('CONSOLE_DEVICE_SCOPE');
  return scanJoinInvitation(this.context());
 }
 async joinDevice(encoded:string):Promise<string>{
  const current=this.connection(),caller=this.caller();
  if(current===null||!belongsToConsole(current,caller)||encoded.length>32768)throw Error('CONSOLE_DEVICE_SCOPE');
  const bootstrap=JSON.parse(encoded) as Bootstrap;
  if(consoleOrigin(bootstrap.invitation.address)!==current.address||bootstrap.invitation.fingerprint!==current.fingerprint)throw Error('CONSOLE_DEVICE_SCOPE');
  await openAgent(this.context(),bootstrap);await this.paired();
  return JSON.stringify({groupId:bootstrap.invitation.groupId});
 }
}
