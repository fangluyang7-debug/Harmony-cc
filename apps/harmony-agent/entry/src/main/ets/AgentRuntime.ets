import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { NativeAgent } from './NativeAgent';
import { Bootstrap } from './NativePlatform';
let agent:NativeAgent|null=null;
let opening:Promise<NativeAgent>|null=null;
let desiredForeground=false;
let normalForeground=false;
let reviewForeground=false;
export async function openAgent(context:common.UIAbilityContext,bootstrap:Bootstrap|null):Promise<NativeAgent>{
 const local=await preferences.getPreferences(context,{name:'agent-connection-v1'});
 if(bootstrap===null&&await local.get('left',false) as boolean)throw Error('INVITATION_REQUIRED');
 if(opening!==null){if(bootstrap!==null)throw Error('SPACE_SWITCH_BUSY');return opening;}
 if(agent!==null&&(bootstrap===null||agent.displayHolderId()===bootstrap.holderInstanceId))return agent;
 opening=(async():Promise<NativeAgent>=>{
  if(agent!==null){await agent.closeForSwitch();agent=null;}
  return NativeAgent.start(context,bootstrap,()=>desiredForeground);
 })();
 try{agent=await opening;await local.put('left',false);await local.flush();agent.setForeground(desiredForeground);if(bootstrap!==null)AppStorage.setOrCreate('agentCenter',bootstrap.invitation.address);AppStorage.setOrCreate('agentPaired',true);return agent;}
 catch(e){if(agent===null&&bootstrap!==null){try{agent=await NativeAgent.start(context,null,()=>desiredForeground);}catch(_){} }throw e as Error;}
 finally{opening=null;}
}
export function foregroundAgent(value:boolean):void {normalForeground=value;applyForeground();}
export function foregroundReview(value:boolean):void {reviewForeground=value;applyForeground();}
function applyForeground():void{desiredForeground=normalForeground||reviewForeground;agent?.setForeground(desiredForeground);}
export function displayAgent():NativeAgent{if(!agent||!desiredForeground)throw Error('DISPLAY_AGENT_UNAVAILABLE');return agent;}
export async function leaveDisplay(id:string):Promise<void>{if(agent)await agent.displaySession(id,'leave');}
export async function configureAgent(cpu:number,memoryMB:number):Promise<void>{if(agent===null)throw Error('INVITATION_REQUIRED');await agent.configure(cpu,memoryMB);}
export async function contributeAgent(value:boolean):Promise<void>{if(agent===null)throw Error('INVITATION_REQUIRED');await agent.setEnabled(value);}
export async function closeAgent():Promise<void>{if(reviewForeground)return;await agent?.close();agent=null;AppStorage.setOrCreate('agentPaired',false);}

export async function leaveAgent(context:common.UIAbilityContext):Promise<void>{
 if(opening!==null||reviewForeground)throw Error('SPACE_SWITCH_BUSY');
 const current=agent??await openAgent(context,null);
 try{await current.leaveSpace();}catch(e){agent=null;try{agent=await NativeAgent.start(context,null,()=>desiredForeground);}catch(_){}throw e as Error;}
 agent=null;const store=await preferences.getPreferences(context,{name:'agent-connection-v1'});await store.put('left',true);await store.flush();AppStorage.setOrCreate('agentPaired',false);AppStorage.setOrCreate('agentCenter','');AppStorage.setOrCreate('agentStatus','已退出空间，可独立使用图片应用');
}
