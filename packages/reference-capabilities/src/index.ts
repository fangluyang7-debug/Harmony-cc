import { cropEvaluationPack, validRaster } from './crop';
export { cropEvaluationPack } from './crop';
import { createHash } from 'node:crypto';
import { canonical, CapabilityPackV2, ExecutionConfigV2, ResourceAmountV2 } from '@harmony/scheduler-core';

export interface ReferenceCase {id:string;input:Buffer;parameters:string;config:ExecutionConfigV2;maxOutputBytes:number;}
export interface ReferencePack {manifest:CapabilityPackV2;cases:ReferenceCase[];maxOutputBytes:number;evaluate(test:ReferenceCase,output:Buffer):Promise<number>;}
export const cpuResources:ResourceAmountV2[]=[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:67108864}];
export const cpuConfiguration:ExecutionConfigV2={id:'standard',threads:1,batchSize:1,quality:'standard'};
export const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export const packDigest=(pack:ReferencePack)=>digest(Buffer.from(canonical({manifest:pack.manifest,cases:pack.cases.map(c=>({...c,input:digest(c.input)}))})));
function pack(capability:string,inputSchema:string,outputSchema:string,input:unknown,expected:unknown,maxOutputBytes=8388608):ReferencePack {
  return {manifest:{packId:capability,contract:{contractId:capability,version:1,capability,inputSchemas:[inputSchema],outputSchemas:[outputSchema],sideEffectPolicy:'PURE',interruptibility:'CANCEL_RESTART',maxNonPreemptibleMs:null},
    executorIds:['node.cpu.v1','harmony.cpu.v1'],model:null,suiteId:capability+'.reference',qualityThreshold:1,resourceLimit:structuredClone(cpuResources)},
    maxOutputBytes,cases:[{id:'reference',input:Buffer.from(JSON.stringify(input)),parameters:'{}',config:{...cpuConfiguration},maxOutputBytes:4096}],
    evaluate:async(_test,output)=>{try{return canonical(JSON.parse(output.toString('utf8')))===canonical(expected)?1:0;}catch{return 0;}}};
}
/** Compiled, installed reference data; no code or expected answers are loaded from a device advertisement. */
export function builtinCpuPacks():ReferencePack[]{return [
  pack('vector.normalize.v1','vector.input','vector.normalized',{dimension:2,rows:[[3,4],[0,0]]},{dimension:2,rows:[[.6,.8],[0,0]],norms:[5,0]}),
  pack('text.count.v1','text.input','text.counts',{text:'Hello Harmony\n资源协同'},{characters:18,words:3,lines:2},128)
];}
export async function builtinReferencePacks():Promise<ReferencePack[]>{
 const manifest:CapabilityPackV2={packId:'image.crop.v1',contract:{contractId:'image.crop.contract',version:1,capability:'image.crop.v1',inputSchemas:['image.raster'],outputSchemas:['image.raster'],sideEffectPolicy:'PURE',interruptibility:'CANCEL_RESTART',maxNonPreemptibleMs:null},
 executorIds:['harmony.cpu.v1','sharp.crop.v1'],model:null,suiteId:'crop.geometry-colour.v1',qualityThreshold:.98,resourceLimit:structuredClone(cpuResources)};
 return [...builtinCpuPacks(),await cropEvaluationPack(manifest)];
}
export const cpuSchemas=new Map<string,(bytes:Buffer)=>boolean|Promise<boolean>>([
 ['image.raster:1',validRaster],
  ['vector.input:1',bytes=>{try{const v=JSON.parse(bytes.toString());return Number.isSafeInteger(v.dimension)&&v.dimension>0&&v.dimension<=65536&&Array.isArray(v.rows)&&v.rows.every((r:any)=>Array.isArray(r)&&r.length===v.dimension&&r.every(Number.isFinite));}catch{return false;}}],
  ['vector.normalized:1',bytes=>{try{const v=JSON.parse(bytes.toString());return Number.isSafeInteger(v.dimension)&&v.dimension>0&&Array.isArray(v.rows)&&Array.isArray(v.norms)&&v.rows.length===v.norms.length&&v.norms.every(Number.isFinite)&&v.rows.every((r:any)=>Array.isArray(r)&&r.length===v.dimension&&r.every(Number.isFinite));}catch{return false;}}],
  ['text.input:1',bytes=>{try{const v=JSON.parse(bytes.toString());return Object.keys(v).join('|')==='text'&&typeof v.text==='string';}catch{return false;}}],
  ['text.counts:1',bytes=>{try{const v=JSON.parse(bytes.toString());return Object.keys(v).sort().join('|')==='characters|lines|words'&&Object.values(v).every(n=>Number.isSafeInteger(n)&&Number(n)>=0);}catch{return false;}}]
]);
