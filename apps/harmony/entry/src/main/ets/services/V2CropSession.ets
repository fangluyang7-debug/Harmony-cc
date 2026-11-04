import { common } from '@kit.AbilityKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { fileIo } from '@kit.CoreFileKit';
import { image } from '@kit.ImageKit';
import { util } from '@kit.ArkTS';
import { NativeAgent, HarmonySdkPort, SchedulerSdk, SdkTask, SdkWorkflow, SubmitOptions, TrustedCoordinator, Bootstrap, Paired, ResourceAmountV2 } from 'scheduler';
interface Registration extends TrustedCoordinator {registrationId:string;code:string;expiresAt:number;domain:string;}
interface Registered extends Paired {offlineBase:ResourceAmountV2[];onlineExtra:ResourceAmountV2[];}
interface AppInfo {identity:AppIdentity;}
interface AppIdentity {appInstanceId:string;}
class IndexerSession {
 private context:common.UIAbilityContext|null=null;
 private foreground=false;
 private host:NativeAgent|null=null;
 private sdk:SchedulerSdk|null=null;
 private task:SdkTask|null=null;
 private busy=false;
 private stopRequested=false;
 initialize(context:common.UIAbilityContext):void{this.context=context;AppStorage.setOrCreate('indexerStatus','连接后选择图片，生成 128×128 缩略图');AppStorage.setOrCreate('indexerImages',[] as string[]);AppStorage.setOrCreate('indexerBusy',false);}
 lifecycle(value:boolean):void{this.foreground=value;this.host?.setForeground(value);}
 connectedSdk():SchedulerSdk {
  if(!this.sdk||!this.host?.isConnected())throw Error('SDK_COORDINATOR_OFFLINE');
  return this.sdk;
 }
 displayHost():NativeAgent{
  if(!this.host||!this.host.isConnected())throw Error('SDK_COORDINATOR_OFFLINE');
  return this.host;
 }
 async connect(raw:string):Promise<void>{
  if(this.host!==null)return;if(this.context===null)throw Error('APP_CONTEXT_REQUIRED');
  const context=this.context;
  if(raw.trim().length===0)this.host=await NativeAgent.start(context,null,()=>this.foreground);
  else{
   const invite=JSON.parse(raw) as Registration,port=await HarmonySdkPort.open(context,invite);
   const registered=JSON.parse(await port.exchange(invite.registrationId,invite.code)) as Registered;
   const info=JSON.parse(await port.request('/v2/apps/me',null)) as AppInfo;
   const resources=registered.offlineBase.concat(registered.onlineExtra),cpu=resources.filter(r=>r.resourcePoolId==='cpu').reduce((sum,r)=>sum+r.amount,0),ram=resources.filter(r=>r.resourcePoolId==='ram').reduce((sum,r)=>sum+r.amount,0);
   if(cpu<1||ram<67108864)throw Error('APP_HOST_QUOTA_REQUIRED');
   const bootstrap:Bootstrap={invitation:{version:2,inviteId:invite.registrationId,groupId:registered.peer.groupId,address:invite.address,certificate:invite.certificate,fingerprint:invite.fingerprint,code:invite.code,expiresAt:invite.expiresAt},holderInstanceId:registered.peer.holderInstanceId,domain:invite.domain,contribution:{ownerMode:'dedicated',maxCpuThreads:cpu,maxMemoryBytes:ram,reserveMemoryBytes:0}};
   this.host=await NativeAgent.start(context,null,()=>this.foreground,{bootstrap,paired:registered,appInstanceId:info.identity.appInstanceId});
  }
  this.sdk=await this.host.sdk();AppStorage.setOrCreate('indexerStatus','已注册，正在连接并准备执行能力');
 }
 private save(path:string,data:Uint8Array):void{const file=fileIo.openSync(path,fileIo.OpenMode.CREATE|fileIo.OpenMode.WRITE_ONLY|fileIo.OpenMode.TRUNC);try{if(fileIo.writeSync(file.fd,data.slice().buffer)!==data.byteLength)throw Error('FILE_WRITE_INCOMPLETE');}finally{fileIo.closeSync(file);}}
 async selectAndRun():Promise<void>{
  if(this.busy)return;if(this.context===null||this.sdk===null||this.host===null||!this.host.isConnected())throw Error('SDK_COORDINATOR_OFFLINE');
  this.stopRequested=false;this.busy=true;AppStorage.setOrCreate('indexerBusy',true);
  try{
   const picker=new photoAccessHelper.PhotoViewPicker(),selection=await picker.select({MIMEType:photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE,maxSelectNumber:8});
   const outputs:string[]=[];AppStorage.setOrCreate('indexerImages',outputs);
   for(let i=0;i<selection.photoUris.length;i++){
    if(this.stopRequested)break;
    if(!this.foreground)throw Error('APP_BACKGROUND');
    const file=fileIo.openSync(selection.photoUris[i],fileIo.OpenMode.READ_ONLY);let data:Uint8Array;
    try{const size=fileIo.statSync(file.fd).size;if(size<1||size>8388608)throw Error('IMAGE_SIZE_LIMIT');const buffer=new ArrayBuffer(size);if(fileIo.readSync(file.fd,buffer)!==size)throw Error('FILE_READ_INCOMPLETE');data=new Uint8Array(buffer);}finally{fileIo.closeSync(file);}
    const id=util.generateRandomUUID(true);this.save(this.context.filesDir+'/input-'+id,data);
    const input=await this.sdk.registerInput(data,'image.raster');
    try{
     const parameters='{"box":{"x":0,"y":0,"width":1,"height":1},"paddingRatio":0,"targetSize":128,"jpegQuality":90}';
     const workflow:SdkWorkflow={version:3,id,outputContract:'image.raster',qualityTarget:'reference',nodes:[{id:'thumbnail',capability:'image.crop.v1',input,parameters,dependsOn:[]}]};
     const options:SubmitOptions={requestId:id,budgetMs:30000,resultDestination:'ORIGIN',inputLocation:'ORIGIN'};
     AppStorage.setOrCreate('indexerStatus','处理中 '+(i+1)+' / '+selection.photoUris.length);
     this.task=await this.sdk.submit(workflow,options);const result=await this.task.result();
     const source=image.createImageSource(result.output.buffer);try{const info=await source.getImageInfo();if(info.size.width!==128||info.size.height!==128)throw Error('THUMBNAIL_DIMENSIONS');}finally{await source.release();}
     const destination=this.context.filesDir+'/thumbnail-'+id+'.jpg';this.save(destination,result.output);outputs.push('file://'+destination);AppStorage.setOrCreate('indexerImages',outputs.slice());
    }finally{this.sdk.releaseInput(input);this.task=null;}
   }
   AppStorage.setOrCreate('indexerStatus','已完成 '+outputs.length+' 张缩略图');
  }finally{this.busy=false;AppStorage.setOrCreate('indexerBusy',false);}
 }
 async cancel():Promise<void>{this.stopRequested=true;if(this.task!==null){await this.task.cancel();AppStorage.setOrCreate('indexerStatus','已请求取消，等待执行端结算');}}
 async close():Promise<void>{await this.host?.close();}
}
export const indexer=new IndexerSession();
export function showError(error:Error):void{AppStorage.setOrCreate('indexerStatus',error.message);}
