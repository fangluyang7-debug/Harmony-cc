import { common } from '@kit.AbilityKit';
import { openAgent } from '../AgentRuntime';
interface ResourceSummary {resourcePoolId:string;amount:number;}
interface RequestSummary {label:string;allowedContracts:string[];resources:ResourceSummary[];}
@Entry
@Component
struct Enrollment {
 @StorageLink('enrollmentRequest') request:string='';
 @State busy:boolean=false;
 @State status:string='仅授予当前请求独立的 App 身份，不共享设备凭据。';
 private summary():string {
  try{const d=JSON.parse(this.request) as RequestSummary;return d.label+'\n请求能力：'+d.allowedContracts.join('、')+'\n任务额度：'+d.resources.map(r=>r.resourcePoolId+' = '+r.amount).join('，');}
  catch(e){return '无效的应用接入请求';}
 }
 private async approve():Promise<void>{
  if(this.busy)return;this.busy=true;
  const context=getContext(this) as common.UIAbilityContext;
  try{
   const agent=await openAgent(context,null);const end=Date.now()+15000;
   while(!agent.isConnected()&&Date.now()<end)await new Promise<void>(resolve=>{setTimeout(resolve,250);});
   const invitation=await agent.registerApplication(JSON.parse(this.request) as Object);
   await context.terminateSelfWithResult({resultCode:0,want:{parameters:{registration:invitation}}});
  }catch(e){this.status=(e as Error).message;this.busy=false;}
 }
 build(){Column({space:20}){
  Text('允许应用使用协同调度').fontSize(26).fontWeight(FontWeight.Bold)
  Text(this.summary()).fontSize(17)
  Text(this.status).fontSize(15)
  Button('允许并返回应用').enabled(!this.busy&&this.request.length>0).onClick(()=>{void this.approve();})
  Button('取消').enabled(!this.busy).onClick(()=>{void (getContext(this) as common.UIAbilityContext).terminateSelfWithResult({resultCode:1});})
 }.padding(24).width('100%').height('100%').justifyContent(FlexAlign.Center)}
}
