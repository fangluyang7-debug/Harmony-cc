import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { DevicePanel } from './DevicePanel';
import { ConsoleDeviceBridge } from '../ConsoleDeviceBridge';
import { ConsoleConnection, consoleConnection, saveConsoleAddress, saveInvitedConsole, belongsToConsole, matchesConsoleCertificate } from '../ConsoleConnection';
import { parseJoinInvitation, scanJoinInvitation } from '../JoinInvitation';
import { discoverCenters } from '../Discovery';

@Entry
@Component
struct Index {
 @State section:string='space';
 @State address:string='';
 @State origin:string='';
 @State webUrl:string='about:blank';
 @State message:string='';
 @State loading:boolean=false;
 @State discovered:string='';
 private async discover():Promise<void>{try{const centers=await discoverCenters();this.discovered=centers.length?'附近中心：'+centers.join('，')+'。首次接入仍需扫码或完整邀请。':'未发现中心，仍可直接扫码或使用完整邀请。';}catch(e){this.discovered='发现暂不可用，请直接扫码或使用完整邀请。';}}
 @State joinKey:string='';
 private connection:ConsoleConnection|null=null;
 private controller:webview.WebviewController=new webview.WebviewController();
 private bridge:ConsoleDeviceBridge=new ConsoleDeviceBridge(()=>this.context(),()=>this.connection,
  ()=>this.controller.getLastJavascriptProxyCallingFrameUrl(),async()=>{
   const connection=await consoleConnection(this.context());if(connection!==null){this.connection=connection;this.origin=connection.address;this.address=connection.address;}
  });
 private attached:boolean=false;
 aboutToAppear():void {void this.restoreConnection();}
 private context():common.UIAbilityContext{return this.getUIContext().getHostContext() as common.UIAbilityContext;}
 private async joinInvitation(value:string):Promise<void>{
  try{const invitation=parseJoinInvitation(value);await saveInvitedConsole(this.context(),invitation.connection);
   this.connection=invitation.connection;this.origin=invitation.connection.address;this.address=this.origin;this.section='space';this.message='';
   this.webUrl=this.origin+'/#join='+encodeURIComponent(invitation.code);if(this.attached)this.controller.loadUrl(this.webUrl);
  }catch(e){this.message=(e as Error).message;}
 }
 private async restoreConnection():Promise<void>{
  try{const connection=await consoleConnection(this.context());if(connection===null)return;
   this.connection=connection;this.origin=connection.address;this.address=connection.address;this.openSection(this.section);
  }catch(e){this.message=(e as Error).message;}
 }
 private openSection(section:string):void {
  this.section=section;if(section==='device'||this.connection===null)return;
  const path=section==='dashboard'?'/dispatch.html'+(this.connection.groupId?'?space='+encodeURIComponent(this.connection.groupId):''):'/';
  this.webUrl=this.connection.address+path;this.message='';this.loading=true;
  if(this.attached){try{this.controller.loadUrl(this.webUrl);}catch(e){this.message='页面尚未准备好，请点击刷新。';}}
 }
 private ssl(event:SslErrorEvent):void {
  try{const chain=event.certChainData;
   if(this.connection!==null&&!event.isFatalError&&event.error===SslError.Untrusted&&chain&&chain.length>0&&matchesConsoleCertificate(this.connection,event.url,chain[0])){event.handler.handleConfirm();return;}
  }catch(e){}
  event.handler.handleCancel();this.loading=false;this.message='协调中心证书尚未确认或已变化。请在“本机设备”使用负责人提供的邀请完成配对，然后重试。';
 }
 onBackPress():boolean {
  if(this.section==='device'){this.openSection('space');return true;}
  try{if(this.attached&&this.controller.accessBackward()){this.controller.backward();return true;}}catch(e){}
  return false;
 }
 build(){Column(){
  Row({space:12}){
   Text('Harmony').fontSize(21).fontWeight(FontWeight.Bold).fontColor('#172B49').layoutWeight(1);
   if(this.origin&&this.section!=='device'){
    Button('返回').fontSize(13).onClick(()=>{try{if(this.controller.accessBackward())this.controller.backward();}catch(e){}});
    Button('刷新').fontSize(13).onClick(()=>{this.message='';this.loading=true;try{this.controller.refresh();}catch(e){this.openSection(this.section);}});
   }
  }.padding({left:20,right:20,top:12,bottom:12}).width('100%').backgroundColor('#FFFFFF');
  if(this.message){Text(this.message).fontSize(13).fontColor('#9A5A12').padding(12).width('100%').backgroundColor('#FFF6E7');}
  if(this.loading&&this.section!=='device'){Text('正在连接协调中心…').fontSize(12).fontColor('#2457EB').padding(4);}
  Stack(){
   if(this.origin){
    Web({src:this.webUrl,controller:this.controller}).width('100%').height('100%')
     .javaScriptAccess(true).domStorageAccess(true)
     .javaScriptProxy({object:this.bridge,name:'harmonyDevice',methodList:['available','joinDevice','scanInvite','info','pickPhoto','pickImportedPhoto'],asyncMethodList:[],controller:this.controller})
     .onControllerAttached(()=>{this.attached=true;})
     .onPageEnd(()=>{this.loading=false;})
     .onSslErrorEvent((event:SslErrorEvent)=>{this.ssl(event);})
     .onLoadIntercept(event=>{
      if(event.data.isMainFrame()&&this.connection!==null&&!belongsToConsole(this.connection,event.data.getRequestUrl())){this.message='请在当前协调中心内操作。';return true;}return false;
     })
     .onErrorReceive(event=>{if(event.request.isMainFrame()){this.loading=false;this.message='页面连接失败，请确认设备与协调中心处于同一网络，再点击刷新。';}})
     .visibility(this.section==='device'?Visibility.Hidden:Visibility.Visible);
   }else{
    Column({space:22}){
     Text('让协作从这里开始').fontSize(28).fontWeight(FontWeight.Bold).fontColor('#172B49');
     Button('搜索附近的协调中心').onClick(()=>{void this.discover();});
     if(this.discovered){Text(this.discovered).fontSize(13).fontColor('#64748B');}
     Text('连接团队的协调中心，即可在应用内创建或加入空间、查看调度盘。设备配对后会自动填写地址。').fontSize(16).fontColor('#64748B');
     Button('扫码加入空间').width('100%').onClick(()=>{void scanJoinInvitation(this.context()).then(value=>this.joinInvitation(value)).catch((e:Error)=>{this.message=e.message;});});
     TextInput({placeholder:'粘贴完整接入密钥',text:this.joinKey}).onChange(v=>{this.joinKey=v;});
     Button('使用密钥加入').width('100%').onClick(()=>{void this.joinInvitation(this.joinKey);});
     TextInput({placeholder:'或输入 https://协调中心地址:7443',text:this.address}).onChange(v=>{this.address=v;});
     Button('连接协作空间').width('100%').onClick(()=>{void saveConsoleAddress(this.context(),this.address).then(()=>this.restoreConnection()).catch((e:Error)=>{this.message=e.message;});});
     Button('设备连接面板').width('100%').onClick(()=>{this.getUIContext().getRouter().pushUrl({url:'pages/ConnectionLauncher'});});
     Button('使用设备邀请接入').width('100%').onClick(()=>{this.section='device';});
    }.constraintSize({maxWidth:640}).padding(28).width('100%').visibility(this.section==='device'?Visibility.Hidden:Visibility.Visible);
   }
   Column(){DevicePanel({onPaired:()=>{this.section='space';void this.restoreConnection();}});}.width('100%').height('100%').backgroundColor('#F5F7FC').visibility(this.section==='device'?Visibility.Visible:Visibility.Hidden);
  }.layoutWeight(1).width('100%');
  Row({space:8}){
   ForEach(['space','dashboard','device'],(item:string)=>{
    Button(item==='space'?'协作空间':item==='dashboard'?'调度盘':'本机设备')
     .layoutWeight(1).fontSize(15).height(46).borderRadius(12)
     .backgroundColor(this.section===item?'#2457EB':'#EEF2FA').fontColor(this.section===item?'#FFFFFF':'#425473')
     .onClick(()=>{if(this.section!==item)this.openSection(item);});
   });
  }.padding(12).width('100%').backgroundColor('#FFFFFF');
 }.width('100%').height('100%').backgroundColor('#F5F7FC')}
}
