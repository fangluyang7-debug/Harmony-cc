import photoRuntime from 'libharmony_photo.so';
import { common } from '@kit.AbilityKit';
import { executePhoto } from './Photo';
import { EngineResult } from './Types';
import { bytes, text, hash, base64 } from '../NativePlatform';

interface Geometry { width:number; height:number; }
interface Tile extends Geometry { x:number; y:number; }
interface LocalPart { nodeId:string; schemaId:string; contentHash:string; bytes:number; data:string; }
interface LocalBundle { version:number; parts:LocalPart[]; }
export interface LocalPhotoProgress { completed:number; total:number; stage:string; }
export interface LocalPhotoOptions { cancelled:()=>boolean; progress:(value:LocalPhotoProgress)=>void; }
export async function encodePhotoRgbFile(source:string,destination:string,width:number,height:number):Promise<void>{await photoRuntime.encodeRgbFile(source,destination,width,height);}

/** App-owned offline operation. Uses the same kernels, tiles and model as photo.*;
 * no coordinator, registration, SDK dispatch or input upload is involved. */
export async function enhancePhotoLocally(context:common.UIAbilityContext,input:Uint8Array,options:LocalPhotoOptions):Promise<Uint8Array>{
 let completed=0,total=1;
 const cores=Math.min(64,photoRuntime.cpuCount()),threads=[8,4,2].find((n:number)=>n<=Math.max(1,Math.floor(cores/2)))??1,parallel=Math.max(1,Math.floor(cores/threads));
 const stage=async(capability:string,data:Uint8Array,parameters:string,label:string):Promise<EngineResult>=>{
  if(options.cancelled())throw Error('CANCELLED_SETTLED');
  options.progress({completed,total,stage:label});
  const result=await executePhoto(capability,{context,input:data,parameters,model:null,threads,cancelled:options.cancelled});
  completed++;options.progress({completed,total,stage:label});return result;
 };
 const source=await stage('photo.analyze.v1',input,'{}','分析照片');
 const geometry=JSON.parse(text(source.data)) as Geometry,w=geometry.width,h=geometry.height;
 if(w<1||h<1||w*h>1048576||Math.max(w,h)>1920)throw Error('PHOTO_GEOMETRY_LIMIT');
 const edge=Math.max(64,Math.ceil(Math.max(w,h)/2)),tiles:Tile[]=[];
 for(let y=0;y<h;y+=edge)for(let x=0;x<w;x+=edge)tiles.push({x,y,width:Math.min(edge,w-x),height:Math.min(edge,h-y)});
 total=3+tiles.length*2;
 const parts:LocalPart[]=[];
 // Use the same per-tile thread policy as the cooperative host, bounded by actual cores.
 // All admitted siblings settle before cancellation/failure is returned to the caller.
 for(let start=0;start<tiles.length;start+=parallel){
  const group=tiles.slice(start,start+parallel).map(async(tile:Tile,offset:number):Promise<LocalPart>=>{
   const i=start+offset;
   const prepared=await stage('photo.prepare.v1',source.data,JSON.stringify(tile),'准备图块 '+(i+1)+'/'+tiles.length);
   const enhanced=await stage('photo.enhance.v1',prepared.data,JSON.stringify({width:tile.width,height:tile.height}),'AI 高清增强 '+(i+1)+'/'+tiles.length);
   return {nodeId:'enhance-'+i,schemaId:enhanced.schemaId,contentHash:hash(enhanced.data),bytes:enhanced.data.length,data:base64.encodeToStringSync(enhanced.data)};
  });
  const settled=await Promise.allSettled(group);
  for(const item of settled){if(item.status==='rejected')throw item.reason as Error;parts.push(item.value);}
 }
 const bundle:LocalBundle={version:1,parts};
 const assembled=await stage('photo.assemble.v1',bytes(JSON.stringify(bundle)),JSON.stringify({width:w,height:h}),'合成并校验');
 return (await stage('photo.deliver.v1',assembled.data,JSON.stringify({width:w*4,height:h*4}),'生成高清成品')).data;
}
