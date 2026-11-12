import { image } from '@kit.ImageKit';
import { util } from '@kit.ArkTS';
import { canonical } from '../core/CanonicalV2';
interface Vector {dimension:number;rows:number[][];norms?:number[];}
interface CropExpected {size:number;color:number[];format:string;tolerance:number;metricVersion:number;}
interface PhotoRect {x:number;y:number;width:number;height:number;}
interface PhotoEnvelope {width:number;height:number;stage?:string;rect?:PhotoRect;image:string;}
interface Pixels {width:number;height:number;rgba:Uint8Array;}
const text=(data:Uint8Array):string=>util.TextDecoder.create('utf-8').decodeToString(data);
const base64=new util.Base64Helper();
async function pixels(data:Uint8Array):Promise<Pixels>{
 const source=image.createImageSource(data.slice().buffer as ArrayBuffer);let map:image.PixelMap|null=null;
 try{const info=await source.getImageInfo();if(info.size.width<1||info.size.height<1||info.size.width*info.size.height>16777216)throw Error('REFERENCE_IMAGE_LIMIT');map=await source.createPixelMap({desiredPixelFormat:image.PixelMapFormat.RGBA_8888});const rgba=new Uint8Array(info.size.width*info.size.height*4);await map.readPixelsToBuffer(rgba.buffer as ArrayBuffer);return {width:info.size.width,height:info.size.height,rgba};}finally{await map?.release();await source.release();}
}
async function pixelScore(a:Uint8Array,b:Uint8Array):Promise<number>{const x=await pixels(a),y=await pixels(b);if(x.width!==y.width||x.height!==y.height)return 0;let error=0;for(let i=0;i<x.rgba.length;i+=4)for(let c=0;c<3;c++)error+=Math.abs(x.rgba[i+c]-y.rgba[i+c]);return Math.max(0,1-error/(255*x.width*x.height*3));}
/** Same reference metrics as reference-capabilities; platform ImageKit replaces sharp decoding. */
export async function coordinatorReferenceScore(capability:string,input:string,expected:Object,output:Uint8Array):Promise<number>{
 try{
  if(capability==='vector.normalize.v1'){
   const v=JSON.parse(text(base64.decodeSync(input))) as Vector,o=JSON.parse(text(output)) as Vector;
   if(o.dimension!==v.dimension||!Array.isArray(o.rows)||o.rows.length!==v.rows.length||!Array.isArray(o.norms)||o.norms.length!==v.rows.length||o.rows.some(r=>!Array.isArray(r)||r.length!==v.dimension))return 0;
   for(let i=0;i<v.rows.length;i++){const n=Math.hypot(...v.rows[i]);if(Math.abs(o.norms[i]-n)>1e-10*Math.max(1,n)||Math.abs(Math.hypot(...o.rows[i])-(n?1:0))>=1e-10||v.rows[i].some((x,j)=>Math.abs(o.rows[i][j]-(n?x/n:0))>=1e-10)||!o.rows[i].every(Number.isFinite)||!Number.isFinite(o.norms[i]))return 0;}return 1;
  }
  if(capability==='render.fractal.v1')return base64.encodeToStringSync(output)===expected?1:0;
  if(capability==='image.crop.v1'){
   const e=expected as CropExpected;if(e.metricVersion!==1||e.format!=='jpeg'||output.length<3||output[0]!==255||output[1]!==216||output[2]!==255)return 0;
   const decoded=await pixels(output);if(decoded.width!==e.size||decoded.height!==e.size)return 0;let matches=0;
   for(let i=0;i<decoded.rgba.length;i+=4)if(e.color.every((v,c)=>Math.abs(v-decoded.rgba[i+c])<=e.tolerance))matches++;
   return matches/(decoded.width*decoded.height);
  }
  if(capability.startsWith('photo.')){
   const reference=base64.decodeSync(expected as string);
   if(capability==='photo.assemble.v1')return await pixelScore(reference,output);
   const a=JSON.parse(text(reference)) as PhotoEnvelope,b=JSON.parse(text(output)) as PhotoEnvelope;
   if(a.width!==b.width||a.height!==b.height||a.stage!==b.stage||JSON.stringify(a.rect)!==JSON.stringify(b.rect))return 0;
   return await pixelScore(base64.decodeSync(a.image),base64.decodeSync(b.image));
  }
  if(['text.count.v1','catalog.filter.v1','image.visual-match.v1'].includes(capability))return canonical(JSON.parse(text(output)) as Object)===canonical(expected)?1:0;
  return 0;
 }catch(e){return 0;}
}
