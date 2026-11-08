import { common } from '@kit.AbilityKit';
import { scanBarcode } from '@kit.ScanKit';
import { discoverCenters } from '../Discovery';
import { Bootstrap } from '../NativePlatform';
import { openAgent, configureAgent, contributeAgent } from '../AgentRuntime';
@Entry
@Component
struct Index {
 @StorageLink('agentStatus') status:string='粘贴协调者生成的设备配对信息';
 @State invitation:string='';
 @State pairing:boolean=false;
 @State center:string='';
 @State discovered:string='';
 aboutToAppear():void{void this.discover();}
 private async discover():Promise<void>{try{const centers=await discoverCenters();this.discovered=centers.length?'发现中心（扫码确认信任）：\n'+centers.join('\n'):'未发现中心，可直接扫描中心二维码';}catch(e){this.discovered='网络未允许自动发现，可直接扫码加入';}}
 private async scan():Promise<void>{
  try{
   const result=await scanBarcode.startScanForResult(getContext(this) as common.UIAbilityContext);
   if(result.originalValue.length>16384)throw Error('INVITATION_INVALID');
   const bootstrap=JSON.parse(result.originalValue) as Bootstrap;
   if(!bootstrap.invitation||bootstrap.invitation.version!==2||bootstrap.invitation.expiresAt<=Date.now()||!bootstrap.contribution)throw Error('INVITATION_INVALID');
   this.invitation=result.originalValue;this.center=bootstrap.invitation.address+'\n证书指纹：'+bootstrap.invitation.fingerprint;
   AppStorage.setOrCreate('agentStatus','请核对中心地址与指纹，然后确认加入');
  }catch(e){AppStorage.setOrCreate('agentStatus',(e as Error).message);}
 }
 private async join():Promise<void>{
  if(this.pairing)return;this.pairing=true;
  try{const bootstrap=JSON.parse(this.invitation) as Bootstrap;await openAgent(getContext(this) as common.UIAbilityContext,bootstrap);this.invitation='';}
  catch(e){AppStorage.setOrCreate('agentStatus',(e as Error).message);}finally{this.pairing=false;}
 }
 @StorageLink('contributing') contributing:boolean=true;
 @StorageLink('cpuLimit') cpuLimit:string='1';
 @StorageLink('memoryLimitMB') memoryLimit:string='256';
 @StorageLink('maxCpuLimit') maxCpuLimit:number=1;
 @StorageLink('maxMemoryLimitMB') maxMemoryLimit:number=256;
 build(){Scroll(){Column({space:14}){
  Text('调度连接').fontSize(28).fontWeight(FontWeight.Bold);
  Text(this.status).fontSize(17);
  Text(this.discovered).fontSize(14);
  Button('搜索附近的调度中心').onClick(()=>{void this.discover();});
  Button('扫码加入调度中心').enabled(!this.pairing).onClick(()=>{void this.scan();});
  Text(this.center).fontSize(13);
  Button('结果展示').onClick(()=>{this.getUIContext().getRouter().pushUrl({url:'pages/Display'});});
  TextArea({placeholder:'设备邀请 JSON（来自局域网控制台）',text:this.invitation}).height(160).onChange(v=>{this.invitation=v;});
  Button('确认配对并加入').enabled(!this.pairing&&this.invitation.length>0).onClick(()=>{void this.join();});
  Text('贡献上限：CPU 槽位 ≤ '+this.maxCpuLimit+'；内存 ≤ '+this.maxMemoryLimit+' MiB').fontSize(14);
  Row({space:12}){TextInput({placeholder:'CPU 槽位',text:this.cpuLimit}).type(InputType.Number).layoutWeight(1).onChange(v=>{this.cpuLimit=v;});TextInput({placeholder:'内存 MiB',text:this.memoryLimit}).type(InputType.Number).layoutWeight(1).onChange(v=>{this.memoryLimit=v;});}
  Button('应用贡献上限').onClick(()=>{void configureAgent(Number(this.cpuLimit),Number(this.memoryLimit)).catch((e:Error)=>{AppStorage.set('agentStatus',e.message);});});
  Row({space:16}){Text('启用前台贡献');Toggle({type:ToggleType.Switch,isOn:this.contributing}).onChange(v=>{void contributeAgent(v).catch((e:Error)=>{AppStorage.set('agentStatus',e.message);});});}
  Text('前台贡献；切到后台即停止新任务准入。额度上限取自配对时确认的贡献设置。').fontSize(14).fontColor('#64748b');
 }.padding(24).width('100%')}.height('100%')}
}
