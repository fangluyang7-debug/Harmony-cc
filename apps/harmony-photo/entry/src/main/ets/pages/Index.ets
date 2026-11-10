import { scanBarcode, scanCore } from '@kit.ScanKit';
import { PhotoDisplay } from '../PhotoDisplay';
import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { enhancePhotoLocally, text, monotonic, LocalPhotoProgress } from 'scheduler';
import { photoSession } from '../PhotoSession';
import { PhotoBridge } from '../PhotoBridge';
import { PhotoInput, PhotoResult, pickLocalPhotos, readPhoto, storePhotoResult, savePhotoToAlbum } from '../PhotoFiles';
@Entry
@Component
struct Index {
 @State private url:string='';
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
 @State private remoteResults:PhotoResult[]=[];
 @State private selectedRemote:number=0;
 @State private progress:number=0;
 @State private phase:string='';
 @State private elapsed:string='';
 private cancelled:boolean=false;
 private controller:webview.WebviewController=new webview.WebviewController();
 private bridge:PhotoBridge=new PhotoBridge(()=>this.context(),()=>this.controller.getLastJavascriptProxyCallingFrameUrl(),(result:PhotoResult)=>{
  const i=this.remoteResults.findIndex(r=>r.id===result.id);
  if(i<0){this.remoteResults=[...this.remoteResults,result];this.selectedRemote=this.remoteResults.length-1;}else this.selectedRemote=i;
 });
 private context():common.UIAbilityContext{return this.getUIContext().getHostContext() as common.UIAbilityContext;}
 private async connect(force:boolean=false):Promise<void>{
  if(this.busy||this.connecting)return;this.connecting=true;this.connectionFailed=false;this.connectionStatus='正在连接协作空间…';
  try{await photoSession.connect(force,(message:string)=>{this.connectionStatus=message;});const c=photoSession.connection();if(c){this.remoteResults=[];this.url=c.address+'/photo-mobile.html?space='+encodeURIComponent(c.groupId)+'&app=photo';this.status='已连接协作空间';this.connectionStatus='已授权并连接 · '+c.address;}}
  catch(e){this.connectionFailed=true;this.connectionStatus='协作连接未完成：'+(e as Error).message;this.status='本机处理仍可使用。请检查调度连接 App 的当前空间，或点击重新授权。';}
  finally{this.connecting=false;}
 }
 private async connectDisplay(scan:boolean):Promise<void>{
  this.displayBusy=true;try{if(scan){const result=await scanBarcode.startScanForResult(this.context(),{scanTypes:[scanCore.ScanType.QR_CODE],enableMultiMode:false,enableAlbum:true});this.displayCode=result.originalValue;}await this.display.connect(this.displayCode);await this.display.select(this.inputs);}catch(e){this.displayStatus=(e as Error).message;}finally{this.displayBusy=false;}
 }
 private async pick():Promise<void>{
  if(this.inputs.length>=8){this.status='每批最多 8 张照片，可先清空选择再添加。';return;}this.picking=true;this.display.picking();
  try{const added=await pickLocalPhotos(this.context(),8-this.inputs.length);const offset=this.inputs.length;
   added.forEach((p:PhotoInput,i:number)=>{p.name='照片 '+(offset+i+1);});this.inputs=[...this.inputs,...added];
   if(added.length)this.status='已选择 '+this.inputs.length+' 张照片，点击开始后在本机计算。';await this.display.select(this.inputs);
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
   if(remote)this.remoteResults=[...this.remoteResults];else this.results=[...this.results];
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
 aboutToDisappear():void{this.cancelled=true;}
 onBackPress():boolean{if(this.busy){this.cancelled=true;this.status='正在结束当前图块，之后停止处理。';return true;}if(this.url){this.url='';return true;}return false;}
 build(){Column(){
  Row({space:10}){
   Column({space:4}){Text('Harmony 图片演示').fontSize(23).fontWeight(FontWeight.Bold).fontColor('#172B49');Text(this.url?'协作空间 · 自动规划':'本机高清增强 · 离线可用').fontSize(12).fontColor('#64748B');}.alignItems(HorizontalAlign.Start).layoutWeight(1);
   if(this.url){Button('本机处理').fontSize(13).onClick(()=>{this.url='';});}
  }.padding(20).width('100%').backgroundColor(Color.White);
  if(this.url){
   Text(this.connectionStatus).fontSize(13).fontColor('#16815D').padding(12).width('100%').backgroundColor(Color.White);
   Web({src:this.url,controller:this.controller}).width('100%').layoutWeight(1).javaScriptAccess(true).domStorageAccess(true)
    .javaScriptProxy({object:this.bridge,name:'harmonyPhoto',methodList:['info','request','sdkRequest','sdkWrite','sdkRead','pickPhoto','stageResult'],asyncMethodList:[],controller:this.controller})
    .onSslErrorEvent((event:SslErrorEvent)=>{if(!event.isFatalError&&event.error===SslError.Untrusted&&event.certChainData?.length&&photoSession.matches(event.url,event.certChainData[0]))event.handler.handleConfirm();else event.handler.handleCancel();})
    .onLoadIntercept(event=>{if(!event.data.isMainFrame())return false;const c=photoSession.connection();return c===null||!event.data.getRequestUrl().startsWith(c.address+'/photo-mobile.html?');});
   if(this.remoteResults.length){
    Column({space:8}){
     Scroll(){Row({space:8}){ForEach(this.remoteResults,(result:PhotoResult,index:number)=>{Button(result.name).fontSize(12).backgroundColor(index===this.selectedRemote?'#2457EB':'#64748B').onClick(()=>{this.selectedRemote=index;});},(result:PhotoResult)=>result.id);}}.scrollable(ScrollDirection.Horizontal).width('100%');
     this.saveButton(this.remoteResults[this.selectedRemote],true);
     Text(this.status).fontSize(12).fontColor('#64748B');
    }.padding(12).backgroundColor(Color.White).width('100%');
   }
  }else{
   Scroll(){Column({space:20}){
    Column({space:12}){
     Text('选好照片，直接变清晰').fontSize(27).fontWeight(FontWeight.Bold).fontColor('#172B49').width('100%');
     Text('手机本地完成 4 倍高清增强。也可以连接协作空间，让其他设备一起参与计算。').fontSize(15).fontColor('#64748B').lineHeight(23).width('100%');
     Row({space:10}){Button(this.connecting?'正在连接…':'连接协作空间').fontSize(14).enabled(!this.busy&&!this.connecting).onClick(()=>{void this.connect();});
      Button('打开协作空间').fontSize(13).backgroundColor('#EAF0FF').fontColor('#2457EB').enabled(!this.busy).onClick(()=>{void this.context().startAbility({bundleName:'org.harmonycc.agent',abilityName:'EntryAbility'}).catch(()=>{this.status='请先安装 Harmony 协作空间';});});
     }.width('100%');
     Text(this.connectionStatus).fontSize(14).fontColor(this.connectionFailed?'#B42318':'#2457EB').lineHeight(22).width('100%');
     if(this.connectionFailed){Button('重新授权当前协作空间').fontSize(14).enabled(!this.busy&&!this.connecting).onClick(()=>{void this.connect(true);});}
    }.padding(20).backgroundColor(Color.White).borderRadius(20).width('100%');
    Column({space:8}){
     Text('仅展示连接').fontSize(17).fontWeight(FontWeight.Bold).fontColor('#172B49').width('100%');
     Text(this.displayStatus).fontSize(12).fontColor('#64748B').width('100%');
     TextInput({text:this.displayCode,placeholder:'粘贴电脑展示页的连接码，也可扫码'}).fontSize(12).enabled(!this.busy&&!this.displayBusy).onChange((value:string)=>{this.displayCode=value;});
     Row({space:8}){Button('扫码连接展示屏').fontSize(13).enabled(!this.busy&&!this.displayBusy).onClick(()=>{void this.connectDisplay(true);});Button('连接').fontSize(13).enabled(!this.busy&&!this.displayBusy).onClick(()=>{void this.connectDisplay(false);});Button('断开').fontSize(13).enabled(!this.busy&&!this.displayBusy).onClick(()=>{void this.display.disconnect();});}.width('100%');
    }.padding(16).backgroundColor(Color.White).borderRadius(18).width('100%');
    Row(){Text('待处理照片 '+this.inputs.length+'/8').fontSize(19).fontWeight(FontWeight.Bold).fontColor('#172B49').layoutWeight(1);if(this.inputs.length)Button('清空选择').fontSize(12).backgroundColor('#EAF0FF').fontColor('#2457EB').enabled(!this.busy&&!this.picking).onClick(()=>{this.inputs=[];void this.display.select([]);});}.width('100%');
    Button(this.picking?'正在选择…':'＋ 从相册选择照片').width('100%').height(50).enabled(!this.busy&&!this.picking).onClick(()=>{void this.pick();});
    if(this.inputs.length){
     Scroll(){Row({space:12}){ForEach(this.inputs,(item:PhotoInput)=>{Column({space:6}){Image('file://'+item.path).width(116).height(88).objectFit(ImageFit.Contain).borderRadius(10);Text(item.name+' · '+item.width+'×'+item.height).fontSize(11).fontColor('#64748B');}},(item:PhotoInput)=>item.id);}}.scrollable(ScrollDirection.Horizontal).width('100%');
     Button(this.busy?'正在本机处理…':'开始本机高清增强').width('100%').height(50).backgroundColor('#2457EB').enabled(!this.busy&&!this.picking).onClick(()=>{void this.runLocal();});
    }
    if(this.busy){Column({space:8}){Progress({value:this.progress,total:100,type:ProgressType.Linear}).width('100%');Text(this.phase).fontSize(14).fontColor('#2457EB');Button('停止后续处理').fontSize(12).onClick(()=>{this.cancelled=true;});}.width('100%');}
    Text(this.status).fontSize(14).fontColor('#64748B').lineHeight(22).width('100%');
    if(this.results.length){
     Row(){Text('高清成品 '+this.results.length).fontSize(20).fontWeight(FontWeight.Bold).fontColor('#172B49').layoutWeight(1);if(this.elapsed)Text(this.elapsed).fontSize(13).fontColor('#64748B');}.width('100%');
     ForEach(this.results,(result:PhotoResult)=>{Column({space:12}){
      Image('file://'+result.path).width('100%').height(230).objectFit(ImageFit.Contain).borderRadius(12);
      Row(){Text(result.name).fontSize(17).fontWeight(FontWeight.Medium).layoutWeight(1);Text(result.width+' × '+result.height).fontSize(12).fontColor('#64748B');}.width('100%');
      this.saveButton(result,false);
     }.padding(16).backgroundColor(Color.White).borderRadius(18).width('100%');},(result:PhotoResult,index:number)=>result.id+':'+index);
    }
    Text('结果先保留在 App 内，只有点击“保存到相册”才写入系统相册。').fontSize(12).fontColor('#8190A6').width('100%');
   }.padding(20).width('100%').constraintSize({maxWidth:760})}.align(Alignment.TopStart).layoutWeight(1).width('100%');
  }
 }.width('100%').height('100%').backgroundColor('#F4F6FC')}
}
