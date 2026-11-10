import sharp from 'sharp';
import type {ReferencePack,ReferenceCase} from './index';
export const PHOTO_CAPABILITIES=['photo.analyze.v1','photo.prepare.v1','photo.enhance.v1','photo.assemble.v1','photo.deliver.v1'];
export const PHOTO_SCHEMAS=['image.raster','photo.source','photo.tile','artifact.bundle','photo.product'];
const installedReference=require('../fixtures/photo-reference.json');
export function photoReference(){return structuredClone(installedReference);}
export function photoPacks():ReferencePack[]{
 const reference=photoReference();
 return reference.stages.map((stage:any):ReferencePack=>{
  const cases:ReferenceCase[]=[{id:'known-image',input:Buffer.from(stage.input,'base64'),parameters:JSON.stringify(stage.parameters),config:{id:'standard',threads:1,batchSize:1,quality:'standard'},maxOutputBytes:65536,covers:['schema:'+stage.inputSchema],expected:stage.expected,expect:{kind:'OUTPUT'}},
   {id:'empty',input:Buffer.from('{}'),parameters:'{}',config:{id:'standard',threads:1,batchSize:1,quality:'standard'},maxOutputBytes:65536,covers:['schema:'+stage.inputSchema,'boundary:empty'],expect:{kind:'REJECT',errorCode:'PHOTO_INVALID'}},
   {id:'oversize-invalid',input:Buffer.from('{"width":1048577}'),parameters:'{}',config:{id:'standard',threads:1,batchSize:1,quality:'standard'},maxOutputBytes:65536,covers:['boundary:max'],expect:{kind:'REJECT',errorCode:'PHOTO_INVALID'}}];
  if(stage.jpegInput)cases.push({...cases[0],id:'jpeg',input:Buffer.from(stage.jpegInput,'base64'),expected:stage.jpegExpected,covers:['schema:image.raster','encoder:jpeg']});
  const enhance=stage.capability==='photo.enhance.v1';
  return {manifest:{packId:stage.capability,contract:{contractId:stage.capability,version:1,capability:stage.capability,inputSchemas:[stage.inputSchema],outputSchemas:[stage.outputSchema],parameterRole:'EXECUTION',sideEffectPolicy:'PURE',interruptibility:'CANCEL_RESTART',maxNonPreemptibleMs:null},executorIds:['node.cpu.v1','harmony.cpu.v1','ncnn.photo.vulkan.v1'],model:enhance?reference.model:null,suiteId:'photo.reference.v1',qualityThreshold:.99,resourceLimit:[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:enhance?536870912:134217728},...(enhance?[{resourcePoolId:'gpu',amount:1},{resourcePoolId:'vram',amount:536870912}]:[])]},cases,maxOutputBytes:8388608,
   evaluate:async(test,output)=>{
    try{const expected=Buffer.from(test.expected as string,'base64');
     if(stage.outputSchema==='image.raster')return await pixels(expected,output);
     const a=JSON.parse(expected.toString()),b=JSON.parse(output.toString());
     if(a.width!==b.width||a.height!==b.height||a.stage!==b.stage||JSON.stringify(a.rect)!==JSON.stringify(b.rect))return 0;
     return await pixels(Buffer.from(a.image,'base64'),Buffer.from(b.image,'base64'));
    }catch{return 0;}
   }};
 });
}
async function pixels(a:Buffer,b:Buffer){const x=await sharp(a).removeAlpha().raw().toBuffer({resolveWithObject:true}),y=await sharp(b).removeAlpha().raw().toBuffer({resolveWithObject:true});if(x.info.width!==y.info.width||x.info.height!==y.info.height||x.data.length!==y.data.length)return 0;let error=0;for(let i=0;i<x.data.length;i++)error+=Math.abs(x.data[i]-y.data[i]);return Math.max(0,1-error/(255*x.data.length));}
export function validPhotoEnvelope(bytes:Buffer){try{const o=JSON.parse(bytes.toString());return o.version===1&&typeof o.image==='string'&&typeof o.hash==='string'&&o.image.length<=11184812&&/^[a-f0-9]{64}$/.test(o.hash);}catch{return false;}}
