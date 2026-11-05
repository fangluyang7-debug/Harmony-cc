import {cropImage} from '../ImageCrop';
import {encodeImage} from '../ImageEncoder';
import {EngineInput,EngineResult,LocalExecutor} from './Types';
import {execute as count} from './Count';
import {execute as normalize} from './Normalize';
export const encoderCapability='image.encode.v1';
async function crop(r:EngineInput):Promise<EngineResult>{return {data:await cropImage(r.input,r.parameters),schemaId:'image.raster'};}
async function encode(r:EngineInput):Promise<EngineResult>{if(!r.model)throw Error('ENCODER_MODEL_REQUIRED');
 let overheadMs:number|undefined;
 const data=await encodeImage(r.context,r.input,r.parameters,r.model,r.cancelled,ms=>{overheadMs=ms;});
 const result:EngineResult={data,schemaId:'image.embedding'};if(overheadMs!==undefined)result.overheadMs=overheadMs;return result;}
const registry=new Map<string,LocalExecutor>();
function register(id:string,engine:LocalExecutor):void{if(registry.has(id))throw Error('EXECUTOR_DUPLICATE');registry.set(id,engine);}
register('image.crop.v1',crop);
register('text.count.v1',count);
register('vector.normalize.v1',normalize);
register(encoderCapability,encode);
export function executeLocal(capability:string,r:EngineInput):Promise<EngineResult>{const executor=registry.get(capability);if(!executor)throw Error('CAPABILITY_UNSUPPORTED');return executor(r);}
