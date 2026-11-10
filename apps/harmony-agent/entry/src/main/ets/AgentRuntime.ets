import { common } from '@kit.AbilityKit';
import { NativeAgent } from './NativeAgent';
import { Bootstrap } from './NativePlatform';
let agent:NativeAgent|null=null;
let opening:Promise<NativeAgent>|null=null;
let desiredForeground=false;
let normalForeground=false;
let reviewForeground=false;
export async function openAgent(context:common.UIAbilityContext,bootstrap:Bootstrap|null):Promise<NativeAgent>{
 if(opening!==null){if(bootstrap!==null)throw Error('SPACE_SWITCH_BUSY');return opening;}
 if(agent!==null&&(bootstrap===null||agent.displayHolderId()===bootstrap.holderInstanceId))return agent;
 opening=(async():Promise<NativeAgent>=>{
  if(agent!==null){await agent.closeForSwitch();agent=null;}
  return NativeAgent.start(context,bootstrap,()=>desiredForeground);
 })();
 try{agent=await opening;const opened=agent;opened.onCoordinatorGone=()=>{if(agent===opened){agent=null;AppStorage.setOrCreate('agentPaired',false);AppStorage.setOrCreate('agentCenter','');}};agent.setForeground(desiredForeground);if(bootstrap!==null)AppStorage.setOrCreate('agentCenter',bootstrap.invitation.address);AppStorage.setOrCreate('agentPaired',true);return agent;}
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
