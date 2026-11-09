import {randomUUID} from 'node:crypto';
import {sameModelV2} from '@harmony/scheduler-core';
import {ReferencePack,VectorSearchSpace,validVectorQuery,validVectorSearchParameters,validCandidateList,vectorSearchCapability,priceStockCapability,rankCapability,validPrices,validSeeds,commitCapability,validCommitReceipt} from '@harmony/reference-capabilities';
import type {ServiceAdapter} from './host';

/**
 * HTTP adapters that let a business service's own capabilities run as ordinary execution targets.
 * The adapter only translates bytes <-> the service's documented API; it never decides placement.
 * Credentials stay in process memory and are never written to the ledger, traces or outputs.
 */
export interface ServiceConnection {baseUrl:string;token:string;routes?:Record<string,string>;timeoutMs?:number;fetchImpl?:typeof fetch;}
const defaultRoutes:Record<string,string>={[vectorSearchCapability]:'/api/v2/image-search/vector',[priceStockCapability]:'/api/v2/stages/price-stock',[rankCapability]:'/api/v2/stages/rank',[commitCapability]:'/api/v2/stages/commit'};
const defaultSpaceRoute='/api/v2/image-search/spaces/';

function endpoint(connection:ServiceConnection,route:string){
  const base=new URL(connection.baseUrl);
  if(!['https:','http:'].includes(base.protocol)||base.username||base.password||base.search||base.hash)throw Error('SERVICE_BASE_URL_INVALID');
  return new URL(route.replace(/^\//,''),base.href.endsWith('/')?base.href:base.href+'/');
}
async function call(connection:ServiceConnection,method:'GET'|'POST',route:string,body:unknown,signal:AbortSignal,extraHeaders:Record<string,string>={}):Promise<{status:number;json:any}>{
  if(signal.aborted)throw Error('CANCELLED_SETTLED');
  const controller=new AbortController(),onAbort=()=>controller.abort();
  signal.addEventListener('abort',onAbort,{once:true});
  const timer=setTimeout(()=>controller.abort(),connection.timeoutMs??20000);
  try{
    const response=await (connection.fetchImpl??fetch)(endpoint(connection,route),{method,signal:controller.signal,
      headers:{authorization:'Bearer '+connection.token,...(body===undefined?{}:{'content-type':'application/json'}),...extraHeaders},body:body===undefined?undefined:JSON.stringify(body)});
    const text=await response.text();
    let json:any=null;try{json=text.length?JSON.parse(text):null;}catch{json=null;}
    return {status:response.status,json};
  }catch(error){
    if(signal.aborted)throw Error('CANCELLED_SETTLED');
    throw Error('SERVICE_UNAVAILABLE');
  }finally{clearTimeout(timer);signal.removeEventListener('abort',onAbort);}
}

/** Fail fast when the live index differs from the declared space: the shared pack digest would no longer describe this service. */
export async function verifyVectorSearchSpace(space:VectorSearchSpace,connection:ServiceConnection,signal:AbortSignal=new AbortController().signal){
  const reply=await call(connection,'GET',(connection.routes?.['vector.search.space']??defaultSpaceRoute)+encodeURIComponent(space.indexSpaceId),undefined,signal);
  if(reply.status!==200||!reply.json)throw Error('SERVICE_INDEX_UNAVAILABLE');
  if(reply.json.indexSpaceId!==space.indexSpaceId||reply.json.indexVersion!==space.indexVersion||!sameModelV2(reply.json.model,space.model))throw Error('SERVICE_INDEX_MISMATCH');
}

export function vectorSearchAdapter(pack:ReferencePack,space:VectorSearchSpace,connection:ServiceConnection):ServiceAdapter {
  if(pack.manifest.contract.capability!==vectorSearchCapability||pack.manifest.contract.serviceId!==space.serviceId)throw Error('SERVICE_ADAPTER_SCOPE');
  const route=connection.routes?.[vectorSearchCapability]??defaultRoutes[vectorSearchCapability];
  return {pack,execute:async(input,parameters,signal)=>{
    let query:unknown,params:unknown;
    try{query=JSON.parse(input.toString('utf8'));params=JSON.parse(parameters);}catch{throw Error('VECTOR_QUERY_INVALID');}
    if(!validVectorQuery(query)||!validVectorSearchParameters(params)||params.indexSpaceId!==space.indexSpaceId)throw Error('VECTOR_QUERY_INVALID');
    const reply=await call(connection,'POST',route,{requestId:randomUUID(),indexSpaceId:params.indexSpaceId,model:query.model,topK:params.topK,vector:query.vector,
      ...(query.category!==undefined?{filters:{category:query.category}}:{})},signal);
    if(reply.status>=400&&reply.status<500)throw Error('QUERY_REJECTED');
    if(reply.status!==200||!reply.json)throw Error('SERVICE_UNAVAILABLE');
    const r=reply.json,output={indexSpaceId:r.indexSpaceId,indexVersion:r.indexVersion,model:r.model,candidates:r.candidates,scoreMeaning:r.scoreMeaning};
    if(!validCandidateList(output))throw Error('SERVICE_OUTPUT_INVALID');
    return {bytes:Buffer.from(JSON.stringify(output)),schemaId:pack.manifest.contract.outputSchemas[0]};
  }};
}

/** Read-only shopping stages (price/stock refresh, final ranking) served by the business service. */
export function stageAdapter(pack:ReferencePack,connection:ServiceConnection):ServiceAdapter {
  const capability=pack.manifest.contract.capability,route=connection.routes?.[capability]??defaultRoutes[capability];
  if(!route||![priceStockCapability,rankCapability].includes(capability))throw Error('SERVICE_ADAPTER_SCOPE');
  return {pack,execute:async(input,parameters,signal)=>{
    let body:any,params:any;
    try{body=JSON.parse(input.toString('utf8'));params=JSON.parse(parameters);}catch{throw Error('STAGE_INPUT_INVALID');}
    if(!body||typeof body!=='object'||Array.isArray(body)||!params||typeof params!=='object'||Array.isArray(params))throw Error('STAGE_INPUT_INVALID');
    const request=capability===priceStockCapability?{requestId:randomUUID(),...(Array.isArray(body.candidates)?{candidates:body.candidates}:{items:body.items})}:{requestId:randomUUID(),items:body.items,filters:params};
    const reply=await call(connection,'POST',route,request,signal);
    if(reply.status>=400&&reply.status<500)throw Error('QUERY_REJECTED');
    if(reply.status!==200||!reply.json)throw Error('SERVICE_UNAVAILABLE');
    const output=capability===priceStockCapability?{priceSource:reply.json.priceSource,items:reply.json.items}:{items:reply.json.items};
    if(!(capability===priceStockCapability?validPrices(output):validSeeds(output)))throw Error('SERVICE_OUTPUT_INVALID');
    return {bytes:Buffer.from(JSON.stringify(output)),schemaId:pack.manifest.contract.outputSchemas[0]};
  }};
}

/** The write step. Business submissions carry the planner's idempotency key; reference evaluation runs as a dry run. */
export function commitAdapter(pack:ReferencePack,connection:ServiceConnection):ServiceAdapter {
  const route=connection.routes?.[commitCapability]??defaultRoutes[commitCapability];
  if(pack.manifest.contract.capability!==commitCapability||pack.manifest.contract.sideEffectPolicy!=='IDEMPOTENT_WRITE')throw Error('SERVICE_ADAPTER_SCOPE');
  return {pack,execute:async(input,_parameters,signal,context)=>{
    let body:any;try{body=JSON.parse(input.toString('utf8'));}catch{throw Error('STAGE_INPUT_INVALID');}
    if(!body||typeof body!=='object'||Array.isArray(body))throw Error('STAGE_INPUT_INVALID');
    if(!context.evaluation&&!context.idempotencyKey)throw Error('IDEMPOTENCY_KEY_REQUIRED');
    const reply=await call(connection,'POST',route,body,signal,{'idempotency-key':context.idempotencyKey??'eval-'+randomUUID(),...(context.evaluation?{'x-dry-run':'true'}:{})});
    if(reply.status>=400&&reply.status<500)throw Error('QUERY_REJECTED');
    if(reply.status!==200||!reply.json||!validCommitReceipt(reply.json))throw Error('SERVICE_OUTPUT_INVALID');
    if(context.evaluation&&reply.json.dryRun!==true)throw Error('SERVICE_DRY_RUN_VIOLATED');
    return {bytes:Buffer.from(JSON.stringify(reply.json)),schemaId:pack.manifest.contract.outputSchemas[0]};
  }};
}
