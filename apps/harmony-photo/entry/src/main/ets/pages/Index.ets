import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { photoSession } from '../PhotoSession';
import { PhotoBridge } from '../PhotoBridge';
@Entry
@Component
struct Index {
 @State private url:string='';
 @State private status:string='先在 Harmony 协作空间加入群组，再授权本应用使用调度服务。';
 @State private busy:boolean=false;
 private controller:webview.WebviewController=new webview.WebviewController();
 private bridge:PhotoBridge=new PhotoBridge(()=>this.getUIContext().getHostContext() as common.UIAbilityContext,()=>this.controller.getLastJavascriptProxyCallingFrameUrl());
 aboutToAppear():void{void this.restore();}
 private show():void{const c=photoSession.connection();if(c)this.url=c.address+'/photo-mobile.html?space='+encodeURIComponent(c.groupId)+'&app=photo';}
 private async restore():Promise<void>{try{if(await photoSession.restore())this.show();}catch(e){this.status='连接暂不可用：'+(e as Error).message;}}
 private async connect():Promise<void>{this.busy=true;try{await photoSession.connect();this.show();}catch(e){this.status=(e as Error).message;}finally{this.busy=false;}}
 build(){Column(){
  Row(){Text('Harmony 图片演示').fontSize(22).fontWeight(FontWeight.Bold).fontColor('#172B49').layoutWeight(1);if(this.url)Button('连接设置').fontSize(13).onClick(()=>{this.url='';});}.padding(18).width('100%');
  if(this.url){
   Web({src:this.url,controller:this.controller}).width('100%').layoutWeight(1).javaScriptAccess(true).domStorageAccess(true)
    .javaScriptProxy({object:this.bridge,name:'harmonyPhoto',methodList:['info','request','sdkRequest','sdkWrite','sdkRead','pickPhoto'],asyncMethodList:[],controller:this.controller})
    .onSslErrorEvent((event:SslErrorEvent)=>{if(!event.isFatalError&&event.error===SslError.Untrusted&&event.certChainData?.length&&photoSession.matches(event.url,event.certChainData[0]))event.handler.handleConfirm();else event.handler.handleCancel();})
    .onLoadIntercept(event=>{if(!event.data.isMainFrame())return false;const c=photoSession.connection();return c===null||!event.data.getRequestUrl().startsWith(c.address+'/photo-mobile.html?');})
  }else{
   Column({space:24}){
    Text('照片在这里处理，设备由协作空间协调').fontSize(28).fontWeight(FontWeight.Bold).fontColor('#172B49');
    Text(this.status).fontSize(17).fontColor('#64748B');
    Button('连接 Harmony 协作空间').enabled(!this.busy).onClick(()=>{void this.connect();});
    Button('打开协作空间').onClick(()=>{void (this.getUIContext().getHostContext() as common.UIAbilityContext).startAbility({bundleName:'org.harmonycc.agent',abilityName:'EntryAbility'}).catch(()=>{this.status='请先安装 Harmony 协作空间';});});
   }.padding(28).width('100%').layoutWeight(1).justifyContent(FlexAlign.Center);
  }
 }.width('100%').height('100%').backgroundColor('#F4F6FC')}
}
