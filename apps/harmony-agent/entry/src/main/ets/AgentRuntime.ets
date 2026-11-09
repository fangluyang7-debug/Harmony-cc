import { common } from '@kit.AbilityKit';
import { NativeAgent } from './NativeAgent';
import { Bootstrap } from './NativePlatform';
let agent:NativeAgent|null=null;
let opening:Promise<NativeAgent>|null=null;
let desiredForeground=true;
export async function openAgent(context:common.UIAbilityContext,bootstrap:Bootstrap|null):Promise<NativeAgent>{
 if(agent!==null){if(bootstrap!==null&&agent.displayHolderId()!==bootstrap.holderInstanceId)throw Error('INSTALLATION_ALREADY_PAIRED');return agent;}
 if(opening!==null){const current=await opening;if(bootstrap!==null&&current.displayHolderId()!==bootstrap.holderInstanceId)throw Error('INSTALLATION_ALREADY_PAIRED');return current;}
 opening=NativeAgent.start(context,bootstrap,()=>desiredForeground);
 try{
  agent=await opening;
  agent.setForeground(desiredForeground);
  if(bootstrap!==null)AppStorage.setOrCreate('agentCenter',bootstrap.invitation.address);
  AppStorage.setOrCreate('agentPaired',true);
  return agent;
 }finally{opening=null;}
}
export function foregroundAgent(value:boolean):void {desiredForeground=value;agent?.setForeground(value);}
export function displayAgent():NativeAgent{if(!agent||!desiredForeground)throw Error('DISPLAY_AGENT_UNAVAILABLE');return agent;}
export async function leaveDisplay(id:string):Promise<void>{if(agent)await agent.displaySession(id,'leave');}
export async function configureAgent(cpu:number,memoryMB:number):Promise<void>{if(agent===null)throw Error('INVITATION_REQUIRED');await agent.configure(cpu,memoryMB);}
export async function contributeAgent(value:boolean):Promise<void>{if(agent===null)throw Error('INVITATION_REQUIRED');await agent.setEnabled(value);}
export async function closeAgent():Promise<void>{await agent?.close();agent=null;AppStorage.setOrCreate('agentPaired',false);}
