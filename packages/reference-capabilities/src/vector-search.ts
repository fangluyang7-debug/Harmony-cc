import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {canonical,ModelManifestV2,sameModelV2,validCapabilityPackV2,validModelManifestV2} from '@harmony/scheduler-core';
import type {ReferenceCase,ReferencePack} from './index';
import {propertyPack} from './evaluation';
import {validateCoverage} from './coverage';

/**
 * Vector search over a catalogue index that a logical service holds.
 * The pack is derived from the index space metadata only, so coordinator and service host
 * build byte-identical packs from the same declaration; a changed index version yields a new
 * suite digest and re-qualification instead of silently serving stale candidates.
 */
export interface VectorSearchSpace {serviceId:string;indexSpaceId:string;indexVersion:string;model:ModelManifestV2;}
export interface VectorQuery {model:ModelManifestV2;vector:number[];category?:string;}
export interface CandidateList {indexSpaceId:string;indexVersion:string;model:ModelManifestV2;candidates:{productId:string;score:number}[];scoreMeaning:string;}
interface Parameters {indexSpaceId:string;topK:number;}

export const vectorSearchCapability='vector.search.v1';
export const serviceExecutorId='service.http.v1';
const indexId=/^[a-z0-9][a-z0-9_-]{0,95}$/;
const config={id:'standard',threads:1,batchSize:1,quality:'standard'} as const;
const maxTopK=100;

export function validVectorSearchSpace(value:unknown):value is VectorSearchSpace {
  const s=value as VectorSearchSpace;
  return !!s&&typeof s==='object'&&Object.keys(s).every(k=>['serviceId','indexSpaceId','indexVersion','model'].includes(k))&&
    typeof s.serviceId==='string'&&/^[a-zA-Z0-9_.:-]{1,128}$/.test(s.serviceId)&&indexId.test(s.indexSpaceId)&&indexId.test(s.indexVersion)&&
    validModelManifestV2(s.model)&&s.model.dtype==='float32'&&s.model.normalization==='l2'&&s.model.dimension<=65536;
}
export function validVectorQuery(value:unknown,dimension?:number):value is VectorQuery {
  const q=value as VectorQuery;
  return !!q&&typeof q==='object'&&!Array.isArray(q)&&Object.keys(q).every(k=>['model','vector','category'].includes(k))&&validModelManifestV2(q.model)&&
    Array.isArray(q.vector)&&q.vector.length>0&&q.vector.length<=65536&&q.vector.every(Number.isFinite)&&(dimension===undefined||q.vector.length===dimension)&&
    (q.category===undefined||typeof q.category==='string'&&q.category.length>0&&q.category.length<=128);
}
export function validCandidateList(value:unknown):value is CandidateList {
  const c=value as CandidateList;
  return !!c&&typeof c==='object'&&!Array.isArray(c)&&Object.keys(c).every(k=>['indexSpaceId','indexVersion','model','candidates','scoreMeaning'].includes(k))&&
    indexId.test(c.indexSpaceId)&&indexId.test(c.indexVersion)&&validModelManifestV2(c.model)&&typeof c.scoreMeaning==='string'&&
    Array.isArray(c.candidates)&&c.candidates.length<=maxTopK&&c.candidates.every(e=>!!e&&typeof e==='object'&&Object.keys(e).every(k=>['productId','score'].includes(k))&&
      typeof e.productId==='string'&&e.productId.trim().length>0&&e.productId.length<=256&&Number.isFinite(e.score));
}
export function validVectorSearchParameters(value:unknown):value is Parameters {
  const p=value as Parameters;
  return !!p&&typeof p==='object'&&!Array.isArray(p)&&Object.keys(p).every(k=>['indexSpaceId','topK'].includes(k))&&indexId.test(p.indexSpaceId)&&
    Number.isSafeInteger(p.topK)&&p.topK>=1&&p.topK<=maxTopK;
}

function unit(dimension:number,axis:number):number[]{const v=new Array<number>(dimension).fill(0);v[axis%dimension]=1;return v;}
function uniform(dimension:number):number[]{const x=1/Math.sqrt(dimension);return new Array<number>(dimension).fill(x);}

const invariants=[
  {id:'shape',version:1,check:(c:{space:VectorSearchSpace;topK:number},o:CandidateList)=>o.indexSpaceId===c.space.indexSpaceId&&sameModelV2(o.model,c.space.model)&&o.candidates.length<=c.topK},
  {id:'version',version:1,check:(c:{space:VectorSearchSpace;topK:number},o:CandidateList)=>o.indexVersion===c.space.indexVersion},
  {id:'order',version:1,check:(_c:unknown,o:CandidateList)=>o.candidates.every((e,i)=>Math.abs(e.score)<=1.000001&&(i===0||o.candidates[i-1].score>=e.score))},
  {id:'unique',version:1,check:(_c:unknown,o:CandidateList)=>new Set(o.candidates.map(e=>e.productId)).size===o.candidates.length}
];
const score=propertyPack(invariants);

export function vectorSearchPack(space:VectorSearchSpace):ReferencePack {
  if(!validVectorSearchSpace(space))throw Error('VECTOR_SEARCH_SPACE_INVALID');
  const model=space.model,d=model.dimension,schema='schema:vector.query';
  const query=(q:VectorQuery)=>Buffer.from(JSON.stringify(q));
  const parameters=(topK:number)=>JSON.stringify({indexSpaceId:space.indexSpaceId,topK});
  const output=(id:string,q:VectorQuery,topK:number,covers:string[]):ReferenceCase=>({id,input:query(q),parameters:parameters(topK),config:{...config},maxOutputBytes:65536,covers:[...new Set([schema,...covers])],expect:{kind:'OUTPUT'},expected:{invariants:invariants.map(({id,version})=>({id,version}))}});
  const reject=(id:string,input:Buffer,topK:number,errorCode:string,covers:string[]):ReferenceCase=>({id,input,parameters:parameters(topK),config:{...config},maxOutputBytes:65536,covers:[...new Set([schema,...covers])],expect:{kind:'REJECT',errorCode}});
  const cases:ReferenceCase[]=[
    output('reference',{model,vector:unit(d,0)},5,[]),
    output('top-min',{model,vector:unit(d,1)},1,['param:topK:min']),
    output('top-max',{model,vector:uniform(d)},maxTopK,['param:topK:max','boundary:max']),
    output('filtered-empty',{model,vector:unit(d,0),category:'reference.no-such-category'},1,['boundary:empty']),
    reject('dimension',query({model,vector:new Array<number>(d+1).fill(0)}),5,'QUERY_REJECTED',[]),
    reject('not-json',Buffer.from('not json'),5,'VECTOR_QUERY_INVALID',[])
  ];
  const suiteHash=createHash('sha256').update(canonical(space)).digest('hex');
  // parameterRole EXECUTION: task.parameters are run parameters (topK); the model space is declared on the
  // pack so planning can match modelManifest, and the service re-verifies the query's manifest at execution.
  const manifest:ReferencePack['manifest']={packId:vectorSearchCapability,contract:{contractId:vectorSearchCapability,version:1,workModel:{version:'vector-search-cost-v1',parameters:[{name:'topK',bucketWidth:10}]},
    capability:vectorSearchCapability,inputSchemas:['vector.query'],outputSchemas:['candidate.list'],sideEffectPolicy:'PURE',interruptibility:'CANCEL_RESTART',maxNonPreemptibleMs:null,serviceId:space.serviceId,parameterRole:'EXECUTION'},
    executorIds:[serviceExecutorId],model,suiteId:'vector-search.'+suiteHash,qualityThreshold:1,resourceLimit:[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:67108864}]};
  if(!validCapabilityPackV2(manifest))throw Error('VECTOR_SEARCH_PACK_INVALID');
  const pack:ReferencePack={manifest,cases,maxOutputBytes:65536,evaluate:async(c,bytes)=>{
    try{
      const result=JSON.parse(bytes.toString('utf8')),p=JSON.parse(c.parameters);
      if(!validCandidateList(result)||!validVectorSearchParameters(p))return 0;
      return score({space,topK:p.topK},result);
    }catch{return 0;}
  }};
  validateCoverage(manifest,cases);
  return pack;
}

export interface ServiceStages {serviceId:string;capabilities:string[];}
interface ServicePackFile {version:1;spaces?:VectorSearchSpace[];stages?:ServiceStages[];}
export interface ServiceDeclaration {spaces:VectorSearchSpace[];stages:ServiceStages[];}
const serviceIdValid=(s:unknown)=>typeof s==='string'&&/^[a-zA-Z0-9_.:-]{1,128}$/.test(s);
/** Shared declaration of service-provided capabilities; coordinator and service host load the same file. */
export async function loadServiceDeclaration(filename:string):Promise<ServiceDeclaration> {
  const file=JSON.parse(await readFile(filename,'utf8')) as ServicePackFile;
  const spaces=file?.spaces??[],stages=file?.stages??[];
  if(!file||file.version!==1||Object.keys(file).some(k=>!['version','spaces','stages'].includes(k))||!Array.isArray(spaces)||!Array.isArray(stages)||spaces.length+stages.length<1||spaces.length>16||stages.length>16||
    !spaces.every(validVectorSearchSpace)||!stages.every(s=>!!s&&typeof s==='object'&&Object.keys(s).join('|')==='serviceId|capabilities'&&serviceIdValid(s.serviceId)&&Array.isArray(s.capabilities)&&s.capabilities.length>0&&s.capabilities.every(c=>typeof c==='string')))throw Error('SERVICE_PACKS_INVALID');
  return {spaces,stages};
}
export async function loadServiceSpaces(filename:string):Promise<VectorSearchSpace[]> {return (await loadServiceDeclaration(filename)).spaces;}
/** Builders for stage capabilities are registered by catalog-stages to avoid an import cycle. */
export const stageBuilders:Record<string,(serviceId:string)=>ReferencePack>={};
export async function loadServicePacks(filename:string):Promise<ReferencePack[]> {
  const declaration=await loadServiceDeclaration(filename);
  const packs=[...declaration.spaces.map(space=>vectorSearchPack(space)),...declaration.stages.flatMap(s=>s.capabilities.map(c=>{const build=stageBuilders[c];if(!build)throw Error('SERVICE_STAGE_UNSUPPORTED');return build(s.serviceId);}))];
  if(new Set(packs.map(p=>p.manifest.contract.capability)).size!==packs.length)throw Error('SERVICE_PACKS_DUPLICATE_CAPABILITY');
  return packs;
}
