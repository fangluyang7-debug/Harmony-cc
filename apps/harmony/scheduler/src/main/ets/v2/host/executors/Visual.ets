import visual from 'libharmony_visual.so';
import {factory} from '../NativePlatform';
import {EngineInput,EngineResult} from './Types';
export async function execute(request:EngineInput):Promise<EngineResult>{
 if(request.parameters!=='{}')throw Error('VISUAL_INVALID');
 const id=factory.id();let stopping=false;
 const timer=setInterval(()=>{if(!stopping&&request.cancelled()){stopping=true;visual.cancel(id);}},50);
 try{return {data:new Uint8Array(await visual.match(id,request.input.slice().buffer as ArrayBuffer)),schemaId:'image.visual-evidence'};}
 finally{clearInterval(timer);}
}
