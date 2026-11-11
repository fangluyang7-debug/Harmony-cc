import {image} from '@kit.ImageKit';
import {fileIo} from '@kit.CoreFileKit';
import photo from 'libharmony_photo.so';
import {bytes,text,hash,base64,factory} from '../NativePlatform';
import {EngineInput,EngineResult} from './Types';
interface Geometry {width?:number;height?:number;pixels?:number;assemble?:boolean;}
function geometry(parameters:string,w:number,h:number):void{const p=JSON.parse(parameters) as Geometry;if((p.width!==undefined||p.height!==undefined)&&(p.width!==w||p.height!==h))throw Error('PHOTO_GEOMETRY_MISMATCH');}
interface Rect {x:number;y:number;width:number;height:number;}
interface Crop {left:number;top:number;width:number;height:number;}
interface Envelope {version:number;width:number;height:number;image:string;hash:string;stage?:string;rect?:Rect;crop?:Crop;scale?:number;model?:string;backend?:string;preview?:string;format?:string;}
interface Part {nodeId:string;schemaId:string;contentHash:string;bytes:number;data:string;}
interface Bundle {version:number;parts:Part[];}
function decode(e:Envelope):Uint8Array{const b=base64.decodeSync(e.image);if(hash(b)!==e.hash)throw Error('PHOTO_INVALID');return b;}
function result(e:Envelope,schemaId:string):EngineResult{const data=bytes(JSON.stringify(e));if(data.length>8388608)throw Error('PHOTO_OUTPUT_TOO_LARGE');return {data,schemaId};}
function rect(r:Rect,w:number,h:number):void{if(!r||![r.x,r.y,r.width,r.height].every(Number.isSafeInteger)||r.x<0||r.y<0||r.width<1||r.height<1||r.x+r.width>w||r.y+r.height>h)throw Error('PHOTO_INVALID');}
async function pixels(data:Uint8Array):Promise<image.PixelMap>{const source=image.createImageSource(data.slice().buffer as ArrayBuffer);try{return await source.createPixelMap({editable:true,desiredPixelFormat:image.PixelMapFormat.RGBA_8888});}finally{await source.release();}}
async function png(p:image.PixelMap):Promise<Uint8Array>{const packer=image.createImagePacker();try{return new Uint8Array(await packer.packing(p,{format:'image/png',quality:100}));}finally{await packer.release();}}
function write(name:string,data:Uint8Array):void{const f=fileIo.openSync(name,fileIo.OpenMode.CREATE|fileIo.OpenMode.WRITE_ONLY|fileIo.OpenMode.TRUNC);try{fileIo.writeSync(f.fd,data.slice().buffer as ArrayBuffer);}finally{fileIo.closeSync(f);}}
function read(name:string):Uint8Array{const f=fileIo.openSync(name,fileIo.OpenMode.READ_ONLY);try{const b=new ArrayBuffer(fileIo.statSync(f.fd).size);fileIo.readSync(f.fd,b);return new Uint8Array(b);}finally{fileIo.closeSync(f);}}
const modelPreparations=new Map<string,Promise<string>>();
function prepareModel(r:EngineInput):Promise<string>{
 const model=r.context.filesDir+'/realesrgan-x4plus',expected=r.model?.weightsHash??'713ee713b0353afaa27976f0563a64a5043bd70b9bd8936c2e26e25ebcdbcddf',key=model+':'+expected;
 const existing=modelPreparations.get(key);if(existing)return existing;
 const pending=(async():Promise<string>=>{
  // Concurrent first-use tiles must never truncate model files while a sibling loads them.
  for(const ext of ['param','bin']){const name=model+'.'+ext;if(!fileIo.accessSync(name))write(name,await r.context.resourceManager.getRawFileContent('realesrgan-x4plus.'+ext));}
  if(hash(read(model+'.param'))!=='35330ececcea33b6c397a72548e788d5d53becee4734c50b7fada36e89f10a86'||hash(read(model+'.bin'))!==expected)throw Error('PHOTO_MODEL_HASH');
  return model;
 })();modelPreparations.set(key,pending);void pending.catch(()=>{modelPreparations.delete(key);});return pending;
}
export function photoAvailable():boolean{return photo!==undefined&&photo!==null&&photo.available();}
export async function executePhoto(capability:string,r:EngineInput):Promise<EngineResult>{
 if(r.cancelled())throw Error('CANCELLED_SETTLED');
 try{
  if(capability==='photo.analyze.v1'){
   const p=await pixels(r.input);try{const info=await p.getImageInfo();if(info.size.width*info.size.height>1048576)throw Error('PHOTO_INVALID');geometry(r.parameters,info.size.width,info.size.height);const b=await png(p);return result({version:1,width:info.size.width,height:info.size.height,hash:hash(b),image:base64.encodeToStringSync(b)},'photo.source');}finally{await p.release();}
  }
  if(capability==='photo.prepare.v1'){
   const e=JSON.parse(text(r.input)) as Envelope,p=JSON.parse(r.parameters) as Rect;rect(p,e.width,e.height);
   const left=Math.max(0,p.x-16),top=Math.max(0,p.y-16),right=Math.min(e.width,p.x+p.width+16),bottom=Math.min(e.height,p.y+p.height+16),pm=await pixels(decode(e));
   try{await pm.crop({x:left,y:top,size:{width:right-left,height:bottom-top}});const b=await png(pm);return result({version:1,stage:'prepared',width:e.width,height:e.height,rect:{x:p.x,y:p.y,width:p.width,height:p.height},crop:{left:(p.x-left)*4,top:(p.y-top)*4,width:p.width*4,height:p.height*4},hash:hash(b),image:base64.encodeToStringSync(b)},'photo.tile');}finally{await pm.release();}
  }
  if(capability==='photo.enhance.v1'){
   if(!photo.available())throw Error('PHOTO_MODEL_NOT_INSTALLED');let prepared=r.input;if((JSON.parse(text(prepared)) as Envelope).stage!=='prepared')prepared=(await executePhoto('photo.prepare.v1',r)).data;const e=JSON.parse(text(prepared)) as Envelope;if(e.stage!=='prepared'||!e.crop||!e.rect)throw Error('PHOTO_INVALID');geometry(r.parameters,e.rect.width,e.rect.height);const pm=await pixels(decode(e)),info=await pm.getImageInfo();const declared=JSON.parse(r.parameters) as Geometry;if(declared.pixels!==undefined&&declared.pixels!==info.size.width*info.size.height){await pm.release();throw Error('PHOTO_INVALID');}
   const rgba=new Uint8Array(info.size.width*info.size.height*4);await pm.readPixelsToBuffer(rgba.buffer as ArrayBuffer);await pm.release();
   const input=new Uint8Array(8+info.size.width*info.size.height*3),view=new DataView(input.buffer);view.setUint32(0,info.size.width,true);view.setUint32(4,info.size.height,true);for(let i=0;i<rgba.length/4;i++){input[8+i*3]=rgba[i*4];input[9+i*3]=rgba[i*4+1];input[10+i*3]=rgba[i*4+2];}
   const prefix=r.context.cacheDir+'/photo-'+factory.id(),source=prefix+'.rgb',dest=prefix+'.out',model=await prepareModel(r);
   write(source,input);try{await photo.run(model+'.param',model+'.bin',source,dest,r.threads??1);if(r.cancelled())throw Error('CANCELLED_SETTLED');
    const raw=read(dest),dv=new DataView(raw.buffer),w=dv.getUint32(0,true),h=dv.getUint32(4,true);if(w!==info.size.width*4||h!==info.size.height*4||raw.length!==8+w*h*3)throw Error('PHOTO_INVALID');
    const out=new Uint8Array(w*h*4);for(let i=0;i<w*h;i++){out[i*4]=raw[8+i*3];out[i*4+1]=raw[9+i*3];out[i*4+2]=raw[10+i*3];out[i*4+3]=255;}
    const target=await image.createPixelMap(out.buffer as ArrayBuffer,{size:{width:w,height:h},srcPixelFormat:image.PixelMapFormat.RGBA_8888,pixelFormat:image.PixelMapFormat.RGBA_8888,editable:true,alphaType:image.AlphaType.OPAQUE});
    try{await target.crop({x:e.crop.left,y:e.crop.top,size:{width:e.crop.width,height:e.crop.height}});const b=await png(target);e.stage='enhanced';e.scale=4;e.model='realesrgan-x4plus';e.backend='CPU';e.image=base64.encodeToStringSync(b);e.hash=hash(b);return result(e,'photo.tile');}finally{await target.release();}
   }finally{if(fileIo.accessSync(source))fileIo.unlinkSync(source);if(fileIo.accessSync(dest))fileIo.unlinkSync(dest);}
  }
  if(capability==='photo.assemble.v1'){
   const bundle=JSON.parse(text(r.input)) as Bundle;if(bundle.version!==1||!bundle.parts?.length)throw Error('PHOTO_INVALID');const tiles:Envelope[]=[];const ids=new Set<string>();
   for(const part of bundle.parts){const b=base64.decodeSync(part.data);if(ids.has(part.nodeId)||b.length!==part.bytes||hash(b)!==part.contentHash)throw Error('PHOTO_INVALID');ids.add(part.nodeId);tiles.push(JSON.parse(text(b)) as Envelope);}
   const w=tiles[0].width,h=tiles[0].height;if(w*h>1048576||w<1||h<1)throw Error('PHOTO_INVALID');geometry(r.parameters,w,h);const out=new Uint8Array(w*h*16*4),coverage=new Uint8Array(w*h);
   for(const e of tiles){if(e.stage!=='enhanced'||e.scale!==4||e.width!==w||e.height!==h||!e.rect)throw Error('PHOTO_INVALID');rect(e.rect,w,h);const t=e.rect,p=await pixels(decode(e));try{const pi=await p.getImageInfo();if(pi.size.width!==t.width*4||pi.size.height!==t.height*4)throw Error('PHOTO_INVALID');const b=new Uint8Array(t.width*t.height*16*4);await p.readPixelsToBuffer(b.buffer as ArrayBuffer);for(let y=0;y<t.height*4;y++)out.set(b.subarray(y*t.width*16,(y+1)*t.width*16),((t.y*4+y)*w*4+t.x*4)*4);}finally{await p.release();}
    for(let y=t.y;y<t.y+t.height;y++)for(let x=t.x;x<t.x+t.width;x++){if(coverage[y*w+x])throw Error('PHOTO_DUPLICATE_TILE');coverage[y*w+x]=1;}
   }
   if(coverage.some(n=>n===0))throw Error('PHOTO_MISSING_TILE');const p=await image.createPixelMap(out.buffer as ArrayBuffer,{size:{width:w*4,height:h*4},srcPixelFormat:image.PixelMapFormat.RGBA_8888,pixelFormat:image.PixelMapFormat.RGBA_8888,editable:false,alphaType:image.AlphaType.OPAQUE});try{return {data:await png(p),schemaId:'image.raster'};}finally{await p.release();}
  }
  if(capability==='photo.deliver.v1'){
   const parameters=JSON.parse(r.parameters) as Geometry;let source=r.input;if(parameters.assemble===true)source=(await executePhoto('photo.assemble.v1',{context:r.context,input:r.input,model:r.model,cancelled:r.cancelled,threads:r.threads,parameters:JSON.stringify({width:parameters.width!/4,height:parameters.height!/4})})).data;
   const p=await pixels(source);try{const info=await p.getImageInfo();geometry(r.parameters,info.size.width,info.size.height);const full=source.length>8&&source[0]===137&&source[1]===80&&source[2]===78&&source[3]===71?source:await png(p);const factor=Math.min(1,480/info.size.width,360/info.size.height);await p.scale(factor,factor);const packer=image.createImagePacker();let preview:Uint8Array;try{preview=new Uint8Array(await packer.packing(p,{format:'image/jpeg',quality:85}));}finally{await packer.release();}return result({version:1,width:info.size.width,height:info.size.height,format:'png',hash:hash(full),image:base64.encodeToStringSync(full),preview:base64.encodeToStringSync(preview)},'photo.product');}finally{await p.release();}
  }
  throw Error('CAPABILITY_UNSUPPORTED');
 }catch(e){const message=(e as Error).message;if(/^PHOTO_|^CANCELLED_/.test(message))throw e as Error;throw Error('PHOTO_INVALID');}
}
