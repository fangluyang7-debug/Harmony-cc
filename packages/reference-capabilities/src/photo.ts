import sharp from 'sharp';
import type {ReferencePack,ReferenceCase} from './index';
export const PHOTO_CAPABILITIES=['photo.analyze.v1','photo.prepare.v1','photo.enhance.v1','photo.assemble.v1','photo.deliver.v1'];
export const PHOTO_SCHEMAS=['image.raster','photo.source','photo.tile','artifact.bundle','photo.product'];
const installedReference=require('../fixtures/photo-reference.json');
const performanceReference=require('../fixtures/photo-performance-reference.json');
export function photoReference(){return structuredClone(installedReference);}
export function photoPacks():ReferencePack[]{
 const reference=photoReference();
 return reference.stages.map((stage:any):ReferencePack=>{
  const cases:ReferenceCase[]=[{id:'known-image',input:Buffer.from(stage.input,'base64'),parameters:JSON.stringify(stage.parameters),config:{id:'standard',threads:1,batchSize:1,quality:'standard'},maxOutputBytes:65536,covers:['schema:'+stage.inputSchema],expected:stage.expected,expect:{kind:'OUTPUT'}},
   {id:'empty',input:Buffer.from('{}'),parameters:'{}',config:{id:'standard',threads:1,batchSize:1,quality:'standard'},maxOutputBytes:65536,covers:['schema:'+stage.inputSchema,'boundary:empty'],expect:{kind:'REJECT',errorCode:'PHOTO_INVALID'}},
   {id:'oversize-invalid',input:Buffer.from('{"width":1048577}'),parameters:'{}',config:{id:'standard',threads:1,batchSize:1,quality:'standard'},maxOutputBytes:65536,covers:['boundary:max'],expect:{kind:'REJECT',errorCode:'PHOTO_INVALID'}}];
  if(stage.jpegInput)cases.push({...cases[0],id:'jpeg',input:Buffer.from(stage.jpegInput,'base64'),expected:stage.jpegExpected,covers:['schema:image.raster','encoder:jpeg']});
  const enhance=stage.capability==='photo.enhance.v1';
  if(enhance){
   cases[1].covers!.push('schema:photo.source');
   for(const [bound,pixels] of [['min',0],['max',1048577]] as const)cases.push({...cases[1],id:'pixels-'+bound,input:Buffer.from(stage.input,'base64'),parameters:JSON.stringify({pixels}),covers:['param:pixels:'+bound]});
   const source=reference.stages.find((s:any)=>s.capability==='photo.prepare.v1'),rect=JSON.parse(Buffer.from(stage.input,'base64').toString()).rect;
   cases.push({...cases[0],id:'fused-prepare',input:Buffer.from(source.input,'base64'),parameters:JSON.stringify({...rect,pixels:48}),covers:['schema:photo.source']});
   cases.push({...cases[0],id:'representative-pixels',input:Buffer.from(performanceReference.input,'base64'),parameters:JSON.stringify(performanceReference.parameters),expected:performanceReference.expected,maxOutputBytes:65536,covers:['geometry:112x112']});
   const original=[...cases];for(const threads of [2,4,8])for(const test of original)cases.push({...test,id:test.id+'-threads-'+threads,config:{...test.config,id:'parallel-'+threads,threads}});}
  if(stage.capability==='photo.deliver.v1'){
   cases[1].covers!.push('schema:artifact.bundle');
   const assemble=reference.stages.find((s:any)=>s.capability==='photo.assemble.v1');cases.push({...cases[0],id:'fused-assemble',input:Buffer.from(assemble.input,'base64'),parameters:JSON.stringify({width:JSON.parse(Buffer.from(stage.expected,'base64').toString()).width,height:JSON.parse(Buffer.from(stage.expected,'base64').toString()).height,assemble:true}),covers:['schema:artifact.bundle']});
  }
  return {manifest:{packId:stage.capability,contract:{contractId:stage.capability,version:enhance||stage.capability==='photo.deliver.v1'?2:1,...(enhance?{workModel:{version:'photo-pixels-v2',inputBytes:'IGNORE' as const,parameters:[{name:'pixels'}],scale:{parameter:'pixels',reference:12544}}}:{}),capability:stage.capability,inputSchemas:enhance?[stage.inputSchema,'photo.source']:stage.capability==='photo.deliver.v1'?[stage.inputSchema,'artifact.bundle']:[stage.inputSchema],outputSchemas:[stage.outputSchema],parameterRole:'EXECUTION',sideEffectPolicy:'PURE',interruptibility:'CANCEL_RESTART',maxNonPreemptibleMs:null},executorIds:['node.cpu.v1','harmony.cpu.v1','ncnn.photo.vulkan.v1'],model:enhance?reference.model:null,suiteId:'photo.reference.v1',qualityThreshold:.99,resourceLimit:[{resourcePoolId:'cpu',amount:enhance?8:1},{resourcePoolId:'ram',amount:enhance?536870912:134217728},...(enhance?[{resourcePoolId:'gpu',amount:1},{resourcePoolId:'vram',amount:536870912}]:[])]},cases,maxOutputBytes:8388608,
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
