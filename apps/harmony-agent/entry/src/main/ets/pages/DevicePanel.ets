import { common } from '@kit.AbilityKit';
import { scanBarcode,scanCore } from '@kit.ScanKit';
import { Bootstrap } from '../NativePlatform';
import { openAgent, configureAgent, contributeAgent } from '../AgentRuntime';
import { resolveDeviceInvitation, readPairingTrust, resolvePairingCode, PairingTrust } from '../DevicePairingLink';
@Component
export struct DevicePanel {
 onPaired:()=>void=()=>{};
 @StorageLink('agentStatus') status:string='粘贴协调者生成的设备配对信息';
 @StorageLink('agentWarning') warning:string='';
 @State invitation:string='';
 @State address:string='';
 @State pairMessage:string='';
 @State pairing:boolean=false;
 @State fingerprint:string='';
 private numericTrust:PairingTrust|null=null;
 @StorageLink('contributing') contributing:boolean=true;
 @StorageLink('cpuLimit') cpuLimit:string='1';
 @StorageLink('memoryLimitMB') memoryLimitMB:string='256';
 @StorageLink('maxCpuLimit') maxCpuLimit:number=1;
 @StorageLink('maxMemoryLimitMB') maxMemoryLimitMB:number=256;
 @StorageLink('deviceTotalMemoryMB') deviceMemory:number=0;
 private async scanDevice():Promise<void>{try{const result=await scanBarcode.startScanForResult(getContext(this) as common.UIAbilityContext,{scanTypes:[scanCore.ScanType.QR_CODE],enableMultiMode:false,enableAlbum:true});const bootstrap=await resolveDeviceInvitation(result.originalValue,getContext(this) as common.UIAbilityContext);this.invitation=JSON.stringify(bootstrap);AppStorage.set('agentStatus','已读取设备邀请。确认配对将退出原空间并接入新空间。');}catch(e){AppStorage.set('agentStatus','未读取有效设备邀请；成员邀请请在协作空间中扫码。');}}
 private async pair():Promise<void>{
  if(this.pairing)return;
  this.pairing=true;this.pairMessage='正在校验邀请并切换空间…';
  try{
   const context=getContext(this) as common.UIAbilityContext,input=this.invitation.trim();
   if(/^\d{6}$/.test(input)&&this.numericTrust===null){
    const trust=await readPairingTrust(this.address.trim().replace(/\/$/,''));
    this.numericTrust=trust;this.fingerprint=trust.fingerprint;
    AppStorage.set('agentStatus','请与协调中心配对窗口核对指纹，一致后点击「确认指纹并配对」。');
    return;
   }
   const bootstrap=/^\d{6}$/.test(input)&&this.numericTrust!==null
    ?await resolvePairingCode(input,this.numericTrust,context):await resolveDeviceInvitation(input,context);
   await openAgent(context,bootstrap);
   this.pairMessage='已完成配对';this.invitation='';this.numericTrust=null;this.fingerprint='';this.onPaired();
  }catch(e){this.pairMessage='配对未完成：'+(e as Error).message;this.numericTrust=null;this.fingerprint='';AppStorage.set('agentStatus',(e as Error).message);}
  finally{this.pairing=false;}
 }
 build(){Scroll(){Column({space:20}){
  Text('本机设备').fontSize(28).fontWeight(FontWeight.Bold);
  Text(this.status).fontSize(17);
  if(this.pairMessage){Text(this.pairMessage).fontSize(15).fontColor('#64748b');}
  Button('连接 SoleAI（首次授权）').onClick(()=>{void (getContext(this) as common.UIAbilityContext).startAbility({action:'org.harmonycc.action.CONNECT_SHOPPING'}).catch(()=>{AppStorage.set('agentStatus','请先安装新版 SoleAI，再连接授权。');});});
  Button('打开图片演示 App').onClick(()=>{void (getContext(this) as common.UIAbilityContext).startAbility({bundleName:'org.harmonycc.photo',abilityName:'EntryAbility'}).catch(()=>{AppStorage.set('agentStatus','请先安装 Harmony 图片演示 App。');});});
  Text('在当前空间授权一次。之后直接使用 SoleAI 的文字、拍照和比价功能，计算期间无需切回 Harmony。').fontSize(14).fontColor('#64748b');
  if(this.warning){Text('最近诊断：'+this.warning).fontSize(12).fontColor('#64748b');}
  Button('结果展示').onClick(()=>{this.getUIContext().getRouter().pushUrl({url:'pages/Display'});});
  TextInput({placeholder:'协调中心地址（输入数字配对码时填写）',text:this.address})
   .enabled(!this.pairing).onChange(v=>{this.address=v;this.numericTrust=null;this.fingerprint='';});
  TextArea({placeholder:'6 位设备配对码、邀请链接或完整邀请 JSON',text:this.invitation}).height(100)
   .enabled(!this.pairing).onChange(v=>{this.invitation=v;this.numericTrust=null;this.fingerprint='';});
  if(this.fingerprint){Text('中心证书指纹：'+this.fingerprint).fontSize(13).copyOption(CopyOptions.LocalDevice);}
  Text('每台设备同一时间只能接入一个空间。此处为高级设备邀请入口，正常入组请使用协作空间。').fontSize(13).fontColor('#64748b');
  Button('扫描设备邀请（高级）').enabled(!this.pairing).onClick(()=>{this.numericTrust=null;this.fingerprint='';void this.scanDevice();});
  Button(this.pairing?'连接中…':this.fingerprint?'确认指纹并配对':'配对并加入')
   .enabled(!this.pairing&&this.invitation.trim().length>0).onClick(()=>{void this.pair();});
  Text('贡献上限：CPU 槽位 ≤ '+this.maxCpuLimit+'；内存 ≤ '+this.maxMemoryLimitMB+' MiB').fontSize(14);
  Text(this.deviceMemory>0?'本机运行内存 '+this.deviceMemory+' MiB；自动额度在连接后按运行内存更新。':'设备设置为自动额度时，连接后按实测运行内存更新上限。').fontSize(13).fontColor('#64748b');
  Row({space:12}){TextInput({placeholder:'CPU 槽位',text:this.cpuLimit}).type(InputType.Number).layoutWeight(1).onChange(v=>{this.cpuLimit=v;});TextInput({placeholder:'内存 MiB',text:this.memoryLimitMB}).type(InputType.Number).layoutWeight(1).onChange(v=>{this.memoryLimitMB=v;});}
  Button('应用贡献上限').onClick(()=>{void configureAgent(Number(this.cpuLimit),Number(this.memoryLimitMB)).catch((e:Error)=>{AppStorage.set('agentStatus',e.message);});});
  Row({space:16}){Text('启用前台贡献');Toggle({type:ToggleType.Switch,isOn:this.contributing}).onChange(v=>{void contributeAgent(v).catch((e:Error)=>{AppStorage.set('agentStatus',e.message);});});}
  Text('前台贡献；切到后台即停止新任务准入。额度上限取自配对时确认的贡献设置。').fontSize(14).fontColor('#64748b');
 }.padding(24).width('100%').constraintSize({maxWidth:640})}.width('100%').height('100%')}
}
