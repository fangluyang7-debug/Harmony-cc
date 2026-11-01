import { common } from '@kit.AbilityKit';
import { Bootstrap } from '../NativePlatform';
import { openAgent, configureAgent, contributeAgent } from '../AgentRuntime';
@Entry
@Component
struct Index {
 @StorageLink('agentStatus') status:string='粘贴协调者生成的设备配对信息';
 @State invitation:string='';
 @StorageLink('contributing') contributing:boolean=true;
 @StorageLink('cpuLimit') cpuLimit:string='1';
 @StorageLink('memoryLimitMB') memoryLimit:string='256';
 @StorageLink('maxCpuLimit') maxCpuLimit:number=1;
 @StorageLink('maxMemoryLimitMB') maxMemoryLimit:number=256;
 build(){Column({space:20}){
  Text('Harmony · 贡献设备').fontSize(28).fontWeight(FontWeight.Bold);
  Text(this.status).fontSize(17);
  TextArea({placeholder:'设备邀请 JSON（来自局域网控制台）',text:this.invitation}).height(160).onChange(v=>{this.invitation=v;});
  Button('配对并加入').onClick(()=>{try{const bootstrap=JSON.parse(this.invitation) as Bootstrap;void openAgent(getContext(this) as common.UIAbilityContext,bootstrap).then(()=>{this.invitation='';}).catch((e:Error)=>{AppStorage.set('agentStatus',e.message);});}catch(e){AppStorage.set('agentStatus','配对信息格式错误');}});
  Text('贡献上限：CPU 槽位 ≤ '+this.maxCpuLimit+'；内存 ≤ '+this.maxMemoryLimit+' MiB').fontSize(14);
  Row({space:12}){TextInput({placeholder:'CPU 槽位',text:this.cpuLimit}).type(InputType.Number).layoutWeight(1).onChange(v=>{this.cpuLimit=v;});TextInput({placeholder:'内存 MiB',text:this.memoryLimit}).type(InputType.Number).layoutWeight(1).onChange(v=>{this.memoryLimit=v;});}
  Button('应用贡献上限').onClick(()=>{void configureAgent(Number(this.cpuLimit),Number(this.memoryLimit)).catch((e:Error)=>{AppStorage.set('agentStatus',e.message);});});
  Row({space:16}){Text('启用前台贡献');Toggle({type:ToggleType.Switch,isOn:this.contributing}).onChange(v=>{void contributeAgent(v).catch((e:Error)=>{AppStorage.set('agentStatus',e.message);});});}
  Text('前台贡献；切到后台即停止新任务准入。额度上限取自配对时确认的贡献设置。').fontSize(14).fontColor('#64748b');
 }.padding(24).width('100%').height('100%').justifyContent(FlexAlign.Center)}
}
