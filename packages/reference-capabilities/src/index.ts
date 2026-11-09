export * from './evaluation';
export {validateCoverage} from './coverage';
import {textReferences,vectorReferences} from './numeric-text-suites';
import { cropEvaluationPack, validRaster } from './crop';
export { cropEvaluationPack } from './crop';
export { loadImageEncodingPack,isLegacyEncodingSuite } from './image-encode';
export { vectorSearchPack,loadServicePacks,loadServiceSpaces,loadServiceDeclaration,validVectorSearchSpace,validVectorQuery,validCandidateList,validVectorSearchParameters,vectorSearchCapability,serviceExecutorId } from './vector-search';
export type { VectorSearchSpace } from './vector-search';
import { validVectorQuery as vectorQuerySchema, validCandidateList as candidateListSchema } from './vector-search';
export { priceStockPack,rankPack,stagePacks,priceStockCapability,rankCapability,validItemRefs,validPrices,validSeeds,validRankFilters } from './catalog-stages';
import { validItemRefs as itemRefsSchema, validPrices as pricesSchema, validSeeds as seedsSchema } from './catalog-stages';
export { commitPack,commitCapability,dryRunTicket,validCommitRequest,validCommitReceipt } from './commit-stage';
import { validCommitRequest as commitRequestSchema, validCommitReceipt as commitReceiptSchema } from './commit-stage';
import { createHash } from 'node:crypto';
import { canonical, CapabilityPackV2, ExecutionConfigV2, ResourceAmountV2, validModelManifestV2 } from '@harmony/scheduler-core';

export interface ReferenceCase {covers?:string[];expect?:{kind:'OUTPUT'}|{kind:'REJECT';errorCode:string};expected?:unknown;id:string;input:Buffer;parameters:string;config:ExecutionConfigV2;maxOutputBytes:number;}
export interface ReferencePack {manifest:CapabilityPackV2;cases:ReferenceCase[];maxOutputBytes:number;evaluate(test:ReferenceCase,output:Buffer):Promise<number>;/** Non-PURE packs whose reference cases run in the service's dry-run mode (no writes). */dryRunEvaluation?:true;}
export const cpuResources:ResourceAmountV2[]=[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:67108864}];
export const cpuConfiguration:ExecutionConfigV2={id:'standard',threads:1,batchSize:1,quality:'standard'};
export const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export const packDigest=(pack:ReferencePack)=>digest(Buffer.from(canonical({manifest:pack.manifest,cases:pack.cases.map(c=>({...c,input:digest(c.input)}))})));
function cpuPack(capability:string,inputSchema:string,outputSchema:string,maxOutputBytes:number):Pick<ReferencePack,'manifest'|'maxOutputBytes'>{
  return {manifest:{packId:capability,contract:{contractId:capability,version:1,capability,inputSchemas:[inputSchema],outputSchemas:[outputSchema],sideEffectPolicy:'PURE',interruptibility:'CANCEL_RESTART',maxNonPreemptibleMs:null},
    executorIds:['node.cpu.v1','harmony.cpu.v1'],model:null,suiteId:capability+'.reference',qualityThreshold:1,resourceLimit:structuredClone(cpuResources)},maxOutputBytes};
}
export function builtinCpuPacks():ReferencePack[]{return [
  vectorReferences(cpuPack('vector.normalize.v1','vector.input','vector.normalized',8388608)),
  textReferences(cpuPack('text.count.v1','text.input','text.counts',128))
];}
export async function builtinReferencePacks():Promise<ReferencePack[]>{
 const manifest:CapabilityPackV2={packId:'image.crop.v1',contract:{contractId:'image.crop.contract',version:1,workModel:{version:'crop-cost-v1',parameters:[{name:'targetSize'},{name:'jpegQuality',bucketWidth:10}]},capability:'image.crop.v1',inputSchemas:['image.raster'],outputSchemas:['image.raster'],sideEffectPolicy:'PURE',interruptibility:'CANCEL_RESTART',maxNonPreemptibleMs:null},
 executorIds:['harmony.cpu.v1','sharp.crop.v1'],model:null,suiteId:'crop.geometry-colour.v1',qualityThreshold:.98,resourceLimit:structuredClone(cpuResources)};
 return [...builtinCpuPacks(),await cropEvaluationPack(manifest)];
}
export const cpuSchemas=new Map<string,(bytes:Buffer)=>boolean|Promise<boolean>>([
 ['image.embedding:1',bytes=>{
   try{
     const {model,vector}=JSON.parse(bytes.toString('utf8'));
     return validModelManifestV2(model)&&model.embeddingKind==='image'&&model.normalization==='l2'&&
       model.dtype==='float32'&&Array.isArray(vector)&&vector.length===model.dimension&&vector.every(Number.isFinite)&&
       Math.abs(vector.reduce((sum:number,x:number)=>sum+x*x,0)-1)<=0.002;
   }catch{return false;}
 }],
 ['image.raster:1',validRaster],
  ['vector.input:1',bytes=>{try{const v=JSON.parse(bytes.toString());return Number.isSafeInteger(v.dimension)&&v.dimension>0&&v.dimension<=65536&&Array.isArray(v.rows)&&v.rows.every((r:any)=>Array.isArray(r)&&r.length===v.dimension&&r.every(Number.isFinite));}catch{return false;}}],
  ['vector.normalized:1',bytes=>{try{const v=JSON.parse(bytes.toString());return Number.isSafeInteger(v.dimension)&&v.dimension>0&&Array.isArray(v.rows)&&Array.isArray(v.norms)&&v.rows.length===v.norms.length&&v.norms.every(Number.isFinite)&&v.rows.every((r:any)=>Array.isArray(r)&&r.length===v.dimension&&r.every(Number.isFinite));}catch{return false;}}],
  ['vector.query:1',bytes=>{try{return vectorQuerySchema(JSON.parse(bytes.toString('utf8')));}catch{return false;}}],
  ['candidate.list:1',bytes=>{try{return candidateListSchema(JSON.parse(bytes.toString('utf8')));}catch{return false;}}],
  ['catalog.item-refs:1',bytes=>{try{return itemRefsSchema(JSON.parse(bytes.toString('utf8')));}catch{return false;}}],
  ['catalog.prices:1',bytes=>{try{return pricesSchema(JSON.parse(bytes.toString('utf8')));}catch{return false;}}],
  ['candidate.seeds:1',bytes=>{try{return seedsSchema(JSON.parse(bytes.toString('utf8')));}catch{return false;}}],
  ['shopping.commit-request:1',bytes=>{try{return commitRequestSchema(JSON.parse(bytes.toString('utf8')));}catch{return false;}}],
  ['shopping.commit-receipt:1',bytes=>{try{return commitReceiptSchema(JSON.parse(bytes.toString('utf8')));}catch{return false;}}],
  ['text.input:1',bytes=>{try{const v=JSON.parse(bytes.toString());return Object.keys(v).join('|')==='text'&&typeof v.text==='string';}catch{return false;}}],
  ['text.counts:1',bytes=>{try{const v=JSON.parse(bytes.toString());return Object.keys(v).sort().join('|')==='characters|lines|words'&&Object.values(v).every(n=>Number.isSafeInteger(n)&&Number(n)>=0);}catch{return false;}}]
]);
