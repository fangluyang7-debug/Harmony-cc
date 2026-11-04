import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {canonical,ModelManifestV2,sameModelV2,validCapabilityPackV2,validModelManifestV2} from '@harmony/scheduler-core';
import type {ReferencePack} from './index';
import {validRaster} from './crop';

interface EncodingSuite {
  model:ModelManifestV2; executorIds:string[]; minimumCosine:number; memoryBytes:number;vramBytes?:number;
  cases:{id:string;imageBase64:string;vector:number[]}[];
}
function unitVector(vector:number[],dimension:number) {
  return Array.isArray(vector)&&vector.length===dimension&&vector.every(Number.isFinite)&&
    Math.abs(vector.reduce((sum,x)=>sum+x*x,0)-1)<=0.002;
}
export async function loadImageEncodingPack(filename:string):Promise<ReferencePack> {
  const suite:EncodingSuite=JSON.parse(await readFile(filename,'utf8'));
  const model=suite.model;
  if(!model||!validModelManifestV2(model)||model.embeddingKind!=='image'||model.dtype!=='float32'||model.normalization!=='l2'||
    model.dimension>65536||!Number.isFinite(suite.minimumCosine)||suite.minimumCosine<=0||suite.minimumCosine>1||
    !Number.isSafeInteger(suite.memoryBytes)||suite.memoryBytes<1||!Array.isArray(suite.cases)||!suite.cases.length||
    suite.cases.length>64)throw Error('ENCODING_SUITE_INVALID');
  const answers=new Map<string,number[]>(),cases:ReferencePack['cases']=[];
  const maxOutputBytes=4096+model.dimension*32;
  for(const c of suite.cases){
    if(!c||typeof c.id!=='string'||!/^[a-zA-Z0-9_.-]{1,64}$/.test(c.id)||answers.has(c.id)||
      typeof c.imageBase64!=='string'||c.imageBase64.length>11184812||!unitVector(c.vector,model.dimension))throw Error('ENCODING_CASE_INVALID');
    const input=Buffer.from(c.imageBase64,'base64');
    if(input.length>8388608||!await validRaster(input))throw Error('ENCODING_CASE_INVALID');
    answers.set(c.id,c.vector);
    cases.push({id:c.id,input,parameters:JSON.stringify(model),config:{id:'standard',threads:1,batchSize:1,quality:'standard'},maxOutputBytes});
  }
  const suiteHash=createHash('sha256').update(canonical(suite)).digest('hex');
  const manifest:ReferencePack['manifest']={packId:'image.encode.v1',contract:{contractId:'image.encode.v1',version:1,capability:'image.encode.v1',
    inputSchemas:['image.raster'],outputSchemas:['image.embedding'],sideEffectPolicy:'PURE',interruptibility:'CANCEL_RESTART',maxNonPreemptibleMs:null},
    executorIds:suite.executorIds,model,suiteId:'encode.'+suiteHash,qualityThreshold:suite.minimumCosine,
    resourceLimit:[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:suite.memoryBytes}]};
  if(!validCapabilityPackV2(manifest)||!suite.executorIds.every(id=>typeof id==='string'&&/^[a-zA-Z0-9_.:-]{1,128}$/.test(id)))throw Error('ENCODING_SUITE_INVALID');
  if(suite.executorIds.includes('pc.image.cuda.v1')){
    if(!Number.isSafeInteger(suite.vramBytes)||suite.vramBytes!<1)throw Error('ENCODING_VRAM_REQUIRED');
    manifest.resourceLimit.push({resourcePoolId:'gpu',amount:1},{resourcePoolId:'vram',amount:suite.vramBytes!});
  }
  return {manifest,cases,maxOutputBytes,evaluate:async(c,bytes)=>{
    const expected=answers.get(c.id);
    try{
      const result=JSON.parse(bytes.toString('utf8'));
      if(!expected||!result.model||!sameModelV2(result.model,model)||!unitVector(result.vector,model.dimension))return 0;
      const dot=expected.reduce((sum,x,i)=>sum+x*result.vector[i],0);
      return Math.min(1,Math.max(0,dot/(Math.sqrt(expected.reduce((s,x)=>s+x*x,0))*Math.sqrt((result.vector as number[]).reduce((s,x)=>s+x*x,0)))));
    }catch{return 0;}
  }};
}
