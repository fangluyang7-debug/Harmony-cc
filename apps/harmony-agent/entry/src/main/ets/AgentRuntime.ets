import { common } from '@kit.AbilityKit';
import { NativeAgent } from './NativeAgent';
import { Bootstrap } from './NativePlatform';
let agent:NativeAgent|null=null;
let opening:Promise<NativeAgent>|null=null;
let desiredForeground=true;
export async function openAgent(context:common.UIAbilityContext,bootstrap:Bootstrap|null):Promise<NativeAgent>{
 if(agent!==null)return agent;
 if(opening!==null)return opening;
 opening=NativeAgent.start(context,bootstrap,()=>desiredForeground);
 try{agent=await opening;agent.setForeground(desiredForeground);return agent;}finally{opening=null;}
}
export function foregroundAgent(value:boolean):void {desiredForeground=value;agent?.setForeground(value);}
export async function configureAgent(cpu:number,memoryMB:number):Promise<void>{if(agent===null)throw Error('INVITATION_REQUIRED');await agent.configure(cpu,memoryMB);}
export async function contributeAgent(value:boolean):Promise<void>{if(agent===null)throw Error('INVITATION_REQUIRED');await agent.setEnabled(value);}
export async function closeAgent():Promise<void>{await agent?.close();agent=null;}
