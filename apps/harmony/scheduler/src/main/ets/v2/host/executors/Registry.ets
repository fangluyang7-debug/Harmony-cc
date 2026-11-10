import {executePhoto,photoAvailable} from './Photo';
import {cropImage} from '../ImageCrop';
import {encodeImage} from '../ImageEncoder';
import {EngineInput,EngineResult,LocalExecutor} from './Types';
import {execute as count} from './Count';
import {execute as normalize} from './Normalize';
import {execute as render} from './Fractal';
import {execute as catalog} from './Catalog';
import {execute as visual} from './Visual';
export const encoderCapability='image.encode.v1';
async function crop(r:EngineInput):Promise<EngineResult>{return {data:await cropImage(r.input,r.parameters),schemaId:'image.raster'};}
async function encode(r:EngineInput):Promise<EngineResult>{if(!r.model)throw Error('ENCODER_MODEL_REQUIRED');
 let overheadMs:number|undefined;
 const data=await encodeImage(r.context,r.input,r.parameters,r.model,r.cancelled,ms=>{overheadMs=ms;});
 const result:EngineResult={data,schemaId:'image.embedding'};if(overheadMs!==undefined)result.overheadMs=overheadMs;return result;}
const registry=new Map<string,LocalExecutor>();
const versions=new Map<string,string>();
export function localExecutorVersion(capability:string):string{return versions.get(capability)??'1';}
function register(id:string,engine:LocalExecutor,version:string='1'):void{if(registry.has(id))throw Error('EXECUTOR_DUPLICATE');registry.set(id,engine);versions.set(id,version);}
register('image.crop.v1',crop);
register('text.count.v1',count);
register('vector.normalize.v1',normalize);
register('render.fractal.v1',render,'native-1');
register('catalog.filter.v1',catalog);
register('image.visual-match.v1',visual,'native-1');
register(encoderCapability,encode);
export function executeLocal(capability:string,r:EngineInput):Promise<EngineResult>{const executor=registry.get(capability);if(!executor)throw Error('CAPABILITY_UNSUPPORTED');return executor(r);}

for(const stage of ['analyze','prepare','assemble','deliver']){const cap='photo.'+stage+'.v1';register(cap,(r:EngineInput)=>executePhoto(cap,r),'photo-1');}
if(photoAvailable())register('photo.enhance.v1',(r:EngineInput)=>executePhoto('photo.enhance.v1',r),'photo-1');
export function hasLocalExecutor(capability:string):boolean{return registry.has(capability);}
