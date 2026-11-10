import { scanBarcode, scanCore } from '@kit.ScanKit';
import { PhotoDisplay } from '../PhotoDisplay';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { enhancePhotoLocally, text, monotonic, LocalPhotoProgress } from 'scheduler';
import { photoSession } from '../PhotoSession';
import { PhotoBatch, BatchProgress } from '../PhotoBatch';
import { PhotoInput, PhotoResult, pickLocalPhotos, readPhoto, storePhotoResult, savePhotoToAlbum } from '../PhotoFiles';
@Entry
@Component
struct Index {
 @State private cooperative:boolean=false;
 @State private status:string='无需登录或加入空间，选图即可在本机处理。';
 @State private displayCode:string='';
 @State private displayStatus:string='可连接电脑展示屏，不加入协调中心。';
 @State private displayBusy:boolean=false;
 private display:PhotoDisplay=new PhotoDisplay((message:string)=>{this.displayStatus=message;});
 @State private connecting:boolean=false;
 @State private connectionStatus:string='未连接协作空间 · 当前为手机本机处理';
 @State private connectionFailed:boolean=false;
 @State private picking:boolean=false;
 @State private busy:boolean=false;
 @State private saving:boolean=false;
 @State private savedIds:string[]=[];
 @State private inputs:PhotoInput[]=[];
 @State private results:PhotoResult[]=[];
 @State private progress:number=0;
 @State private phase:string='';
 @State private elapsed:string='';
 private cancelled:boolean=false;
 private nextPhotoNumber:number=1;
 private batch:PhotoBatch=new PhotoBatch();
 private context():common.UIAbilityContext{return this.getUIContext().getHostContext() as common.UIAbilityContext;}
 private async connect(force:boolean=false):Promise<void>{
  if(this.busy||this.connecting)return;this.connecting=true;this.connectionFailed=false;this.connectionStatus='正在连接协作空间…';
  try{await photoSession.connect(force,(message:string)=>{this.connectionStatus=message;});const c=photoSession.connection();if(c){this.cooperative=true;this.status='已连接，选图后直接开始处理。';this.connectionStatus='已连接协作空间 · 自动规划设备分工';}}
  catch(e){this.connectionFailed=true;this.connectionStatus='协作连接未完成：'+(e as Error).message;this.status='本机处理仍可使用。请检查调度连接 App 的当前空间，或点击重新授权。';}
  finally{this.connecting=false;}
 }
 private async connectDisplay(scan:boolean):Promise<void>{
  this.displayBusy=true;try{if(scan){const result=await scanBarcode.startScanForResult(this.context(),{scanTypes:[scanCore.ScanType.QR_CODE],enableMultiMode:false,enableAlbum:true});this.displayCode=result.originalValue;}await this.display.connect(this.displayCode);await this.display.select(this.inputs);}catch(e){this.displayStatus=(e as Error).message;}finally{this.displayBusy=false;}
 }
 private async pick():Promise<void>{
  if(this.inputs.length>=8){this.status='每批最多 8 张照片，可先清空选择再添加。';return;}this.picking=true;if(!this.cooperative)this.display.picking();
  try{const added=await pickLocalPhotos(this.context(),8-this.inputs.length);
   added.forEach((p:PhotoInput)=>{p.name='照片 '+this.nextPhotoNumber++;});this.inputs=[...this.inputs,...added];
   if(added.length)this.status='已选择 '+this.inputs.length+' 张照片，点击开始后处理。';if(!this.cooperative)await this.display.select(this.inputs);
  }catch(e){this.status=(e as Error).message;}finally{this.picking=false;}
 }
 private async runLocal():Promise<void>{
  if(this.busy||!this.inputs.length)return;
  this.busy=true;this.cancelled=false;this.results=[];this.elapsed='';this.progress=0;
  const began=monotonic();hilog.info(0x0001,'HarmonyPhoto','LOCAL_BATCH_START count=%{public}d',this.inputs.length);
  try{
   await this.display.select(this.inputs);this.display.start();
   await photoSession.prepareLocal();
   for(let i=0;i<this.inputs.length;i++){
    if(this.cancelled)throw Error('CANCELLED_SETTLED');const input=this.inputs[i];
    const product=await enhancePhotoLocally(this.context(),readPhoto(input.path),{cancelled:()=>this.cancelled||monotonic()-began>=180000,progress:(p:LocalPhotoProgress)=>{
     this.phase='第 '+(i+1)+' / '+this.inputs.length+' 张 · '+p.stage;
     this.progress=Math.round((i+p.completed/p.total)/this.inputs.length*100);this.display.progress(i,p.stage,p.completed,p.total);
    }});
    const result=await storePhotoResult(this.context(),text(product),input.name);this.results=[...this.results,result];this.display.result(i,text(product));
    hilog.info(0x0001,'HarmonyPhoto','LOCAL_IMAGE_COMPLETE index=%{public}d hash=%{public}s width=%{public}d height=%{public}d',i,result.id,result.width,result.height);
   }
   this.display.finish(monotonic()-began);this.progress=100;this.status='处理完成。结果尚未保存到相册，请点击成品下方的保存按钮。';
   hilog.info(0x0001,'HarmonyPhoto','LOCAL_BATCH_COMPLETE count=%{public}d durationMs=%{public}d',this.results.length,monotonic()-began);
  }catch(e){this.display.failed((e as Error).message,monotonic()-began);this.status=(e as Error).message==='CANCELLED_SETTLED'?(monotonic()-began>=180000?'180 秒预算已用尽，已完成的结果仍可保存。':'已停止后续处理，已完成的结果仍可保存。'):'处理未完成：'+(e as Error).message;hilog.error(0x0001,'HarmonyPhoto','LOCAL_BATCH_FAILED %{public}s',(e as Error).message);}
  finally{this.elapsed=((monotonic()-began)/1000).toFixed(2)+' 秒';this.busy=false;this.phase='';}
 }
 private async save(result:PhotoResult,remote:boolean):Promise<void>{
  if(this.saving)return;this.saving=true;
  try{await savePhotoToAlbum(this.context(),result);result.saved=true;this.savedIds=[...this.savedIds,result.id];
   this.results=[...this.results];
   this.status=result.name+' 已保存到系统相册';hilog.info(0x0001,'HarmonyPhoto','ALBUM_SAVE_COMPLETE hash=%{public}s',result.id);
  }catch(e){this.status='保存未完成，请重试：'+(e as Error).message;}finally{this.saving=false;}
 }
 @Builder private saveButton(result:PhotoResult,remote:boolean){
  if(this.savedIds.includes(result.id)){Text('✓ 已保存到相册').fontSize(14).fontColor('#16815D').padding(12);}
  else{
   SaveButton({text:SaveDescription.SAVE_TO_GALLERY,icon:SaveIconStyle.FULL_FILLED,buttonType:ButtonType.Capsule})
    .fontSize(16).height(44).enabled(!this.saving)
    .onClick((_event:ClickEvent,value:SaveButtonOnClickResult)=>{
     if(value===SaveButtonOnClickResult.SUCCESS)void this.save(result,remote);
     else this.status='未获得本次保存授权，请再次点击保存按钮。';
    });
  }
 }
 private async useLocal():Promise<void>{
  if(this.busy||this.connecting)return;this.connecting=true;
  try{await photoSession.prepareLocal();this.cooperative=false;this.connectionFailed=false;this.connectionStatus='手机独立处理 · 电脑仅接收展示';}
  catch(e){this.connectionStatus='暂不能切换：'+(e as Error).message;}finally{this.connecting=false;}
 }
 private async run():Promise<void>{
  if(this.busy||this.connecting||this.picking||!this.inputs.length)return;
  if(!this.cooperative){await this.runLocal();return;}
  this.busy=true;this.cancelled=false;this.results=[];this.elapsed='';this.progress=0;this.phase='正在准备协同任务';const began=monotonic();
  try{await this.batch.run(this.context(),this.inputs,{cancelled:()=>this.cancelled,progress:(p:BatchProgress)=>{this.phase=p.phase;this.progress=Math.round(p.completed/p.total*100);},result:(index:number,result:PhotoResult)=>{this.results=[...this.results,result].sort((a:PhotoResult,b:PhotoResult)=>this.inputs.findIndex(i=>i.name===a.name)-this.inputs.findIndex(i=>i.name===b.name));}});this.status='处理完成。成品尚未保存到相册，可逐张点击保存。';}
  catch(e){this.status='本轮未完成：'+(e as Error).message+'。已完成的成品仍可保存。';}
  finally{this.elapsed=((monotonic()-began)/1000).toFixed(2)+' 秒';this.busy=false;this.phase='';}
 }
 private stop():void{this.cancelled=true;this.phase='正在停止任务，请等待执行器结算';if(this.cooperative)void this.batch.cancel();}
 private removeInput(id:string):void{this.inputs=this.inputs.filter(i=>i.id!==id);if(!this.cooperative)void this.display.select(this.inputs);}
 aboutToDisappear():void{if(this.busy)this.stop();}
 onBackPress():boolean{if(this.busy){this.stop();return true;}return false;}
 build(){Column(){
  Column({space:4}){
   Text('Harmony 图片演示').fontSize(23).fontWeight(FontWeight.Bold).fontColor('#172B49').width('100%');
   Text(this.cooperative?'协作空间 · 自动规划':'本机高清增强 · 离线可用').fontSize(13).fontColor('#64748B').width('100%');
  }.padding(20).width('100%').backgroundColor(Color.White);
  Scroll(){Column({space:18}){
   Column({space:12}){
    Text('照片高清增强').fontSize(27).fontWeight(FontWeight.Bold).fontColor('#172B49').width('100%');
    Text('选择照片，完成 4 倍高清增强。处理完成后，可逐张保存到相册。').fontSize(15).fontColor('#64748B').lineHeight(23).width('100%');
    Row({space:10}){
     Button(this.connecting?'正在连接…':this.cooperative?'改用本机处理':'连接协作空间').fontSize(14).enabled(!this.busy&&!this.connecting&&!this.picking).onClick(()=>{if(this.cooperative)void this.useLocal();else void this.connect();});
     Button('打开协作空间').fontSize(13).backgroundColor('#EAF0FF').fontColor('#2457EB').enabled(!this.busy&&!this.connecting).onClick(()=>{void this.context().startAbility({bundleName:'org.harmonycc.agent',abilityName:'EntryAbility'});});
    }.width('100%');
    Text(this.connectionStatus).fontSize(14).fontColor(this.connectionFailed?'#B42318':'#2457EB').lineHeight(22).width('100%');
    if(this.connectionFailed){Button('重新授权当前协作空间').fontSize(14).enabled(!this.busy&&!this.connecting).onClick(()=>{void this.connect(true);});}
   }.padding(18).backgroundColor(Color.White).borderRadius(20).width('100%');
   Column({space:8}){
    Text(this.cooperative?'电脑实时展示':'仅展示连接').fontSize(17).fontWeight(FontWeight.Bold).fontColor('#172B49').width('100%');
    if(this.cooperative){Text('本轮进度和成品会自动同步到协调中心的展示页，无需重新扫码。').fontSize(13).fontColor('#64748B').lineHeight(21).width('100%');}
    else{
     Text(this.displayStatus).fontSize(13).fontColor('#64748B').width('100%');
     TextInput({text:this.displayCode,placeholder:'粘贴展示连接码，或点击扫码'}).fontSize(12).enabled(!this.busy&&!this.displayBusy).onChange((value:string)=>{this.displayCode=value;});
     Row({space:8}){Button('扫码连接展示屏').fontSize(13).enabled(!this.busy&&!this.displayBusy).onClick(()=>{void this.connectDisplay(true);});Button('连接').fontSize(13).enabled(!this.busy&&!this.displayBusy).onClick(()=>{void this.connectDisplay(false);});Button('断开').fontSize(13).enabled(!this.busy&&!this.displayBusy).onClick(()=>{void this.display.disconnect();});}.width('100%');
    }
   }.padding(16).backgroundColor(Color.White).borderRadius(18).width('100%');
   Row(){Text('待处理照片 '+this.inputs.length+'/8').fontSize(19).fontWeight(FontWeight.Bold).fontColor('#172B49').layoutWeight(1);
    if(this.inputs.length)Button('清空选择').fontSize(12).backgroundColor('#EAF0FF').fontColor('#2457EB').enabled(!this.busy&&!this.picking&&!this.connecting).onClick(()=>{this.inputs=[];if(!this.cooperative)void this.display.select([]);});
   }.width('100%');
   ForEach(this.inputs,(item:PhotoInput)=>{Row({space:12}){
    Image('file://'+item.path).width(72).height(60).objectFit(ImageFit.Contain).borderRadius(8);
    Column({space:4}){Text(item.name).fontSize(15).fontColor('#172B49').width('100%');Text(item.width+' × '+item.height).fontSize(12).fontColor('#64748B').width('100%');}.layoutWeight(1);
    Button('移除').fontSize(12).backgroundColor('#EAF0FF').fontColor('#2457EB').enabled(!this.busy&&!this.picking&&!this.connecting).onClick(()=>{this.removeInput(item.id);});
   }.padding(12).width('100%').backgroundColor(Color.White).borderRadius(12);},(item:PhotoInput)=>item.id);
   Button(this.picking?'正在选择…':'＋ 从相册选择照片').width('100%').height(48).enabled(!this.busy&&!this.picking&&!this.connecting&&this.inputs.length<8).onClick(()=>{void this.pick();});
   if(this.inputs.length){Button(this.busy?'正在处理…':'开始高清增强').width('100%').height(50).backgroundColor('#2457EB').enabled(!this.busy&&!this.picking&&!this.connecting&&!this.saving).onClick(()=>{void this.run();});}
   if(this.busy){Column({space:10}){Progress({value:this.progress,total:100,type:ProgressType.Linear}).width('100%');Text(this.phase).fontSize(14).fontColor('#2457EB').width('100%');Button('停止处理').fontSize(13).enabled(!this.cancelled).onClick(()=>{this.stop();});}.width('100%');}
   Text(this.status).fontSize(14).fontColor('#64748B').lineHeight(22).width('100%');
   if(this.results.length){
    Row(){Text('高清成品 '+this.results.length).fontSize(20).fontWeight(FontWeight.Bold).fontColor('#172B49').layoutWeight(1);if(this.elapsed)Text(this.elapsed).fontSize(13).fontColor('#64748B');}.width('100%');
    ForEach(this.results,(result:PhotoResult,index:number)=>{Column({space:12}){
     Image('file://'+result.path).width('100%').height(230).objectFit(ImageFit.Contain).borderRadius(12);
     Row(){Text(result.name).fontSize(17).fontWeight(FontWeight.Medium).fontColor('#172B49').layoutWeight(1);Text(result.width+' × '+result.height).fontSize(12).fontColor('#64748B');}.width('100%');
     this.saveButton(result,false);
    }.padding(16).backgroundColor(Color.White).borderRadius(18).width('100%');},(result:PhotoResult,index:number)=>result.id+':'+index);
   }
   Text('结果先保留在 App 内，只有点击“保存到相册”才写入系统相册。').fontSize(12).fontColor('#8190A6').width('100%');
  }.padding(20).width('100%').constraintSize({maxWidth:760})}.align(Alignment.TopStart).layoutWeight(1).width('100%');
 }.width('100%').height('100%').backgroundColor('#F4F6FC')}
}
