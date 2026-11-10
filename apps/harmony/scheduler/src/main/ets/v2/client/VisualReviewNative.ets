import visual from 'libharmony_visual.so';
import {util} from '@kit.ArkTS';
export async function packVisualRaw(raw:Uint8Array):Promise<Uint8Array>{return new Uint8Array(await visual.pack(util.generateRandomUUID(true),raw.slice().buffer as ArrayBuffer));}
export async function matchVisualLocal(data:Uint8Array,cancelled:()=>boolean):Promise<Uint8Array>{
 const id=util.generateRandomUUID(true);if(cancelled())throw Error('SHOPPING_CANCELLED');
 const timer=setInterval(()=>{if(cancelled())visual.cancel(id);},50);
 try{return new Uint8Array(await visual.match(id,data.slice().buffer as ArrayBuffer));}finally{clearInterval(timer);}
}
