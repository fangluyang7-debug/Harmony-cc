import sharp from 'sharp';
import {runPhotoWorker} from './photo-workers';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {decodeBundle} from '@harmony/reference-capabilities';
import type {CpuExecutor} from './registry';
const MAX=8388608,scale=4;
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function parse(bytes:Buffer){try{return JSON.parse(bytes.toString());}catch{throw Error('PHOTO_INVALID');}}
function image(v:any):Buffer{if(typeof v?.image!=='string')throw Error('PHOTO_INVALID');const b=Buffer.from(v.image,'base64');if(b.length<1||b.length>MAX||hash(b)!==v.hash)throw Error('PHOTO_INVALID');return b;}
function object(v:any):Buffer{const b=Buffer.from(JSON.stringify(v));if(b.length>MAX)throw Error('PHOTO_OUTPUT_TOO_LARGE');return b;}
export function geometry(p:any,w:number,h:number){if((p.width!==undefined||p.height!==undefined)&&(p.width!==w||p.height!==h))throw Error('PHOTO_GEOMETRY_MISMATCH');}
function rectangle(r:any,w:number,h:number){if(!r||![r.x,r.y,r.width,r.height].every(Number.isSafeInteger)||r.x<0||r.y<0||r.width<1||r.height<1||r.x+r.width>w||r.y+r.height>h)throw Error('PHOTO_INVALID');}
export const analyze:CpuExecutor=async(bytes,p)=>{
 try{const source=await sharp(bytes,{limitInputPixels:1048576}).rotate().removeAlpha().toColourspace('srgb').png().toBuffer({resolveWithObject:true});
  geometry(p,source.info.width,source.info.height);return {schemaId:'photo.source',output:object({version:1,width:source.info.width,height:source.info.height,hash:hash(source.data),image:source.data.toString('base64')})};
 }catch{throw Error('PHOTO_INVALID');}
};
export const prepare:CpuExecutor=async(bytes,p)=>{
 const src=parse(bytes),b=image(src);rectangle(p,src.width,src.height);
 // Halo belongs to the model's input, but only the non-overlapping core is committed.
 const halo=16,left=Math.max(0,p.x-halo),top=Math.max(0,p.y-halo),right=Math.min(src.width,p.x+p.width+halo),bottom=Math.min(src.height,p.y+p.height+halo);
 const data=await sharp(b).extract({left,top,width:right-left,height:bottom-top}).png().toBuffer();
 return {schemaId:'photo.tile',output:object({version:1,stage:'prepared',width:src.width,height:src.height,rect:{x:p.x,y:p.y,width:p.width,height:p.height},crop:{left:(p.x-left)*scale,top:(p.y-top)*scale,width:p.width*scale,height:p.height*scale},hash:hash(data),image:data.toString('base64')})};
};
const validations=new Map<string,Promise<void>>();
async function validateModel(model:string){
 const names=['manifest.json','realesrgan-x4plus.param','realesrgan-x4plus.bin'];
 const stats=await Promise.all(names.map(n=>fs.stat(path.join(model,n))));
 const key=JSON.stringify([model,...stats.map(s=>[s.size,s.mtimeMs,s.ctimeMs])]);
 let check=validations.get(key);
 if(!check){check=(async()=>{const manifest=JSON.parse(await fs.readFile(path.join(model,names[0]),'utf8'));for(const name of names.slice(1))if(hash(await fs.readFile(path.join(model,name)))!==manifest.files[name])throw Error('PHOTO_MODEL_HASH');})();validations.clear();validations.set(key,check);check.catch(()=>validations.delete(key));}
 await check;return key;
}
export async function infer(input:Buffer,threads:number,backend='CPU',signal?:AbortSignal,onDiagnostic?:(text:string)=>void,crop?:sharp.Region):Promise<Buffer>{
 const model=process.env.HARMONY_PHOTO_MODEL,runner=process.env.HARMONY_PHOTO_RUNNER;
 if(!model||!runner)throw Error('PHOTO_MODEL_NOT_INSTALLED');
 const modelVersion=await validateModel(model);
 const {data,info}=await sharp(input).removeAlpha().toColourspace('srgb').raw().toBuffer({resolveWithObject:true});
 const legacyVulkan=backend==='VULKAN'&&process.env.HARMONY_PHOTO_VULKAN_RUNTIME!=='harmony-raw-v1';
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harmony-photo-')),source=path.join(dir,legacyVulkan?'input.png':'input.rgb'),destination=path.join(dir,legacyVulkan?'output.png':'output.rgb');
 try{
  const header=Buffer.alloc(8);header.writeUInt32LE(info.width,0);header.writeUInt32LE(info.height,4);await fs.writeFile(source,legacyVulkan?input:Buffer.concat([header,data]));
  if(backend==='CPU'||backend==='VULKAN'&&!legacyVulkan){
   const executable=backend==='CPU'?runner:process.env.HARMONY_PHOTO_VULKAN;if(!executable)throw Error('PHOTO_GPU_UNAVAILABLE');
   await runPhotoWorker(executable,[path.join(model,'realesrgan-x4plus.param'),path.join(model,'realesrgan-x4plus.bin'),source,destination,String(threads),backend],signal,modelVersion,onDiagnostic);
  }
  else await new Promise<void>((resolve,reject)=>{
   if(signal?.aborted){reject(Error('CANCELLED_SETTLED'));return;}
   const executable=backend==='VULKAN'?process.env.HARMONY_PHOTO_VULKAN:runner;if(!executable){reject(Error('PHOTO_GPU_UNAVAILABLE'));return;}
   const args=legacyVulkan?['-i',source,'-o',destination,'-m',model,'-n','realesrgan-x4plus','-s','4','-t','128','-g',process.env.HARMONY_PHOTO_GPU_ID??'0','-j','1:1:1']:[path.join(model,'realesrgan-x4plus.param'),path.join(model,'realesrgan-x4plus.bin'),source,destination,String(threads),backend];
   const child=spawn(executable,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
   let errors='';child.stderr.on('data',b=>{errors=(errors+b.toString()).slice(-65536);});
   const stop=()=>child.kill();process.once('exit',stop);process.once('disconnect',stop);signal?.addEventListener('abort',stop,{once:true});
   child.once('error',reject);child.once('close',code=>{process.removeListener('exit',stop);process.removeListener('disconnect',stop);signal?.removeEventListener('abort',stop);onDiagnostic?.(errors);signal?.aborted?reject(Error('CANCELLED_SETTLED')):code===0?resolve():reject(Error(/PHOTO_[A-Z_]+/.exec(errors)?.[0]??'PHOTO_INFERENCE_FAILED'));});
  });
  if(legacyVulkan){const png=await fs.readFile(destination),m=await sharp(png).metadata();if(m.width!==info.width*4||m.height!==info.height*4)throw Error('PHOTO_MODEL_OUTPUT');return crop?sharp(png).extract(crop).png().toBuffer():png;}
  const result=await fs.readFile(destination),w=result.readUInt32LE(0),h=result.readUInt32LE(4);
  if(w!==info.width*scale||h!==info.height*scale||result.length!==8+w*h*3)throw Error('PHOTO_MODEL_OUTPUT');
  const pixels=sharp(result.subarray(8),{raw:{width:w,height:h,channels:3}});
  // Crop raw inferred pixels before PNG encoding; avoid full-tile encode/decode/re-encode.
  return await (crop?pixels.extract(crop):pixels).png().toBuffer();
 }finally{await fs.rm(dir,{recursive:true,force:true});}
}
export async function enhanceOn(bytes:Buffer,threads:number,backend:string,signal?:AbortSignal,onDiagnostic?:(text:string)=>void){
 const tile=parse(bytes);if(tile.stage!=='prepared')throw Error('PHOTO_INVALID');const b=image(tile);
 const data=await infer(b,threads,backend,signal,onDiagnostic,tile.crop);
 return {schemaId:'photo.tile',output:object({...tile,stage:'enhanced',model:'realesrgan-x4plus',scale,backend,hash:hash(data),image:data.toString('base64')})};
}
export async function enhancementInput(bytes:Buffer,p:any,config:Parameters<CpuExecutor>[2]):Promise<Buffer>{
 if(parse(bytes).stage!=='prepared')bytes=(await prepare(bytes,p,config)).output;
 const tile=parse(bytes);geometry(p,tile.rect?.width,tile.rect?.height);
 if(p.pixels!==undefined){const m=await sharp(image(tile)).metadata();if(p.pixels!==m.width!*m.height!)throw Error('PHOTO_INVALID');}
 return bytes;
}
export const enhance:CpuExecutor=async(bytes,p,config,signal)=>enhanceOn(await enhancementInput(bytes,p,config),config.threads,'CPU',signal);
export const assemble:CpuExecutor=async(bytes,p)=>{
 let parts;try{parts=decodeBundle(bytes);}catch{throw Error('PHOTO_INVALID');}
 const tiles=parts.map(p=>parse(Buffer.from(p.data,'base64'))),first=tiles[0],w=first.width,h=first.height;
 if(!Number.isSafeInteger(w)||!Number.isSafeInteger(h)||w<1||h<1||w*h>1048576)throw Error('PHOTO_INVALID');
 geometry(p,w,h);const covered=new Uint8Array(w*h),layers=[];
 for(const tile of tiles){if(tile.stage!=='enhanced'||tile.width!==w||tile.height!==h||tile.scale!==scale)throw Error('PHOTO_INVALID');rectangle(tile.rect,w,h);const r=tile.rect,b=image(tile),m=await sharp(b).metadata();
  if(m.width!==r.width*scale||m.height!==r.height*scale)throw Error('PHOTO_INVALID');
  for(let y=r.y;y<r.y+r.height;y++)for(let x=r.x;x<r.x+r.width;x++){const i=y*w+x;if(covered[i])throw Error('PHOTO_DUPLICATE_TILE');covered[i]=1;}
  layers.push({input:b,left:r.x*scale,top:r.y*scale});
 }
 if(covered.some(x=>!x))throw Error('PHOTO_MISSING_TILE');
 const data=await sharp({create:{width:w*scale,height:h*scale,channels:3,background:'#000'}}).composite(layers).png().toBuffer();
 return {schemaId:'image.raster',output:data};
};
export const deliver:CpuExecutor=async(bytes,p,config)=>{
 if(p.assemble===true)bytes=(await assemble(bytes,{width:p.width/4,height:p.height/4},config)).output;
 try{const m=await sharp(bytes).metadata();if(!m.width||!m.height)throw Error();
 geometry(p,m.width,m.height);const full=m.format==='png'?bytes:await sharp(bytes).png().toBuffer();
 const preview=await sharp(bytes).resize({width:480,height:360,fit:'inside',withoutEnlargement:true}).jpeg({quality:85}).toBuffer();
 return {schemaId:'photo.product',output:object({version:1,width:m.width,height:m.height,format:'png',hash:hash(full),image:full.toString('base64'),preview:preview.toString('base64')})};
 }catch{throw Error('PHOTO_INVALID');}
};
