import { common } from '@kit.AbilityKit';
import { scanBarcode,scanCore } from '@kit.ScanKit';
import { Bootstrap } from '../NativePlatform';
import { openAgent, configureAgent, contributeAgent } from '../AgentRuntime';
@Component
export struct DevicePanel {
 onPaired:()=>void=()=>{};
 @StorageLink('agentStatus') status:string='粘贴协调者生成的设备配对信息';
 @StorageLink('agentWarning') warning:string='';
 @State invitation:string='';
 @StorageLink('contributing') contributing:boolean=true;
 @StorageLink('cpuLimit') cpuLimit:string='1';
 @StorageLink('memoryLimitMB') memoryLimitMB:string='256';
 @StorageLink('maxCpuLimit') maxCpuLimit:number=1;
 @StorageLink('maxMemoryLimitMB') maxMemoryLimitMB:number=256;
 private async scanDevice():Promise<void>{try{const result=await scanBarcode.startScanForResult(getContext(this) as common.UIAbilityContext,{scanTypes:[scanCore.ScanType.QR_CODE],enableMultiMode:false,enableAlbum:true});const bootstrap=JSON.parse(result.originalValue) as Bootstrap;if(bootstrap.invitation.version!==2)throw Error('INVITATION_INVALID');this.invitation=result.originalValue;AppStorage.set('agentStatus','已读取设备邀请。确认配对将退出原空间并接入新空间。');}catch(e){AppStorage.set('agentStatus','未读取有效设备邀请；成员邀请请在协作空间中扫码。');}}
 build(){Scroll(){Column({space:20}){
  Text('本机设备').fontSize(28).fontWeight(FontWeight.Bold);
  Text(this.status).fontSize(17);
  Button('连接 SoleAI（首次授权）').onClick(()=>{void (getContext(this) as common.UIAbilityContext).startAbility({action:'org.harmonycc.action.CONNECT_SHOPPING'}).catch(()=>{AppStorage.set('agentStatus','请先安装新版 SoleAI，再连接授权。');});});
  Text('在当前空间授权一次。之后直接使用 SoleAI 的文字、拍照和比价功能，计算期间无需切回 Harmony。').fontSize(14).fontColor('#64748b');
  if(this.warning){Text('最近诊断：'+this.warning).fontSize(12).fontColor('#64748b');}
  Button('结果展示').onClick(()=>{this.getUIContext().getRouter().pushUrl({url:'pages/Display'});});
  TextArea({placeholder:'设备邀请 JSON（来自局域网控制台）',text:this.invitation}).height(160).onChange(v=>{this.invitation=v;});
  Text('每台设备同一时间只能接入一个空间。此处为高级设备邀请入口，正常入组请使用协作空间。').fontSize(13).fontColor('#64748b');
  Button('扫描设备邀请（高级）').onClick(()=>{void this.scanDevice();});
  Button('配对并加入').onClick(()=>{try{const bootstrap=JSON.parse(this.invitation) as Bootstrap;void openAgent(getContext(this) as common.UIAbilityContext,bootstrap).then(()=>{this.invitation='';this.onPaired();}).catch((e:Error)=>{AppStorage.set('agentStatus',e.message);});}catch(e){AppStorage.set('agentStatus','配对信息格式错误');}});
  Text('贡献上限：CPU 槽位 ≤ '+this.maxCpuLimit+'；内存 ≤ '+this.maxMemoryLimitMB+' MiB').fontSize(14);
  Row({space:12}){TextInput({placeholder:'CPU 槽位',text:this.cpuLimit}).type(InputType.Number).layoutWeight(1).onChange(v=>{this.cpuLimit=v;});TextInput({placeholder:'内存 MiB',text:this.memoryLimitMB}).type(InputType.Number).layoutWeight(1).onChange(v=>{this.memoryLimitMB=v;});}
  Button('应用贡献上限').onClick(()=>{void configureAgent(Number(this.cpuLimit),Number(this.memoryLimitMB)).catch((e:Error)=>{AppStorage.set('agentStatus',e.message);});});
  Row({space:16}){Text('启用前台贡献');Toggle({type:ToggleType.Switch,isOn:this.contributing}).onChange(v=>{void contributeAgent(v).catch((e:Error)=>{AppStorage.set('agentStatus',e.message);});});}
  Text('前台贡献；切到后台即停止新任务准入。额度上限取自配对时确认的贡献设置。').fontSize(14).fontColor('#64748b');
 }.padding(24).width('100%').constraintSize({maxWidth:640})}.width('100%').height('100%')}
}
