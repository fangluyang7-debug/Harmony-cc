import {validCapabilityPackV2} from '@harmony/scheduler-core';
import type {ReferenceCase,ReferencePack} from './index';
import {propertyPack} from './evaluation';
import {validateCoverage} from './coverage';
import {serviceExecutorId,stageBuilders} from './vector-search';
import type {CandidateSeed} from './catalog-stages';

/**
 * shopping.commit.v1 — the one write step of a scheduled shopping workflow.
 * IDEMPOTENT_WRITE: every submission carries a business idempotency key; a replay returns the same
 * session. Qualification runs the reference cases in the service's dry-run mode (nothing is written),
 * which is why the pack is flagged `dryRunEvaluation`.
 */
export const commitCapability='shopping.commit.v1';
export const dryRunTicket='dry-run';
const config={id:'standard',threads:1,batchSize:1,quality:'standard'} as const;
const money=/^\d{1,100}(\.\d{1,100})?$/,stock=['in_stock','out_of_stock','unknown'];
const text=(v:unknown,max=2048)=>typeof v==='string'&&v.length>0&&v.length<=max;

export interface CommitRequest {ticket:string;query:{text:string;categoryHint?:string;filters?:Record<string,unknown>};candidates:CandidateSeed[];answer?:string;}
export interface CommitReceipt {dryRun:boolean;sessionId:string;wouldCreate?:boolean;writes?:string[];candidateCount?:number;created?:boolean;replay?:boolean;candidateSnapshotId?:string;stateVersion?:number;}

export function validCommitRequest(v:unknown):v is CommitRequest {
  const r=v as CommitRequest;
  return !!r&&typeof r==='object'&&!Array.isArray(r)&&Object.keys(r).every(k=>['ticket','query','candidates','answer'].includes(k))&&text(r.ticket,4096)&&!!r.query&&typeof r.query==='object'&&
    Object.keys(r.query).every(k=>['text','categoryHint','filters'].includes(k))&&text(r.query.text,2000)&&(r.query.categoryHint===undefined||text(r.query.categoryHint,128))&&
    (r.query.filters===undefined||!!r.query.filters&&typeof r.query.filters==='object'&&!Array.isArray(r.query.filters))&&Array.isArray(r.candidates)&&r.candidates.length<=200&&
    r.candidates.every(c=>!!c&&typeof c==='object'&&text(c.platformName,128)&&text(c.productUrl)&&typeof c.amount==='string'&&money.test(c.amount)&&stock.includes(c.stockStatus)&&typeof c.title==='string')&&
    (r.answer===undefined||text(r.answer,8000));
}
export function validCommitReceipt(v:unknown):v is CommitReceipt {
  const r=v as CommitReceipt;
  return !!r&&typeof r==='object'&&!Array.isArray(r)&&Object.keys(r).every(k=>['dryRun','sessionId','wouldCreate','writes','candidateCount','created','replay','candidateSnapshotId','stateVersion'].includes(k))&&
    typeof r.dryRun==='boolean'&&text(r.sessionId,128)&&(r.wouldCreate===undefined||typeof r.wouldCreate==='boolean')&&(r.writes===undefined||Array.isArray(r.writes)&&r.writes.every(w=>typeof w==='string'))&&
    (r.created===undefined||typeof r.created==='boolean')&&(r.replay===undefined||typeof r.replay==='boolean')&&(r.stateVersion===undefined||Number.isSafeInteger(r.stateVersion));
}
const invariants=[
  // Reference cases run as dry runs: the service must say so and must never report a real write.
  {id:'dry-run-only',version:1,check:(_c:unknown,o:CommitReceipt)=>o.dryRun===true&&o.created===undefined},
  {id:'declares-writes',version:1,check:(_c:unknown,o:CommitReceipt)=>o.wouldCreate===false&&Array.isArray(o.writes)&&o.writes.length===0||o.wouldCreate===true&&Array.isArray(o.writes)&&o.writes.length>0},
  {id:'counts-candidates',version:1,check:(c:{input:CommitRequest},o:CommitReceipt)=>o.candidateCount===c.input.candidates.length}
];
const score=propertyPack(invariants);
const seed=(i:number):CandidateSeed=>({title:'reference '+i,platformName:'reference-platform',amount:String(100+i),currency:'CNY',shopName:'reference',shopType:'reference',stockStatus:'in_stock',coverImageUrl:'https://reference.invalid/i/'+i,productUrl:'https://reference.invalid/p/'+i,matchSummary:{},normalizedAttributes:{},rawPayload:{},recommendationReason:[]});

export function commitPack(serviceId:string):ReferencePack {
  if(typeof serviceId!=='string'||!/^[a-zA-Z0-9_.:-]{1,128}$/.test(serviceId))throw Error('SERVICE_ID_INVALID');
  const schema='schema:shopping.commit-request';
  const mk=(id:string,input:unknown,covers:string[],errorCode?:string):ReferenceCase=>({id,input:Buffer.from(typeof input==='string'?input:JSON.stringify(input)),parameters:'{}',config:{...config},maxOutputBytes:8192,covers:[...new Set([schema,...covers])],
    expect:errorCode?{kind:'REJECT',errorCode}:{kind:'OUTPUT'},...(errorCode?{}:{expected:{invariants:invariants.map(({id,version})=>({id,version}))}})});
  const request=(n:number,extra:Partial<CommitRequest>={}):CommitRequest=>({ticket:dryRunTicket,query:{text:'reference query',filters:{sortRule:'relevance_desc'}},candidates:Array.from({length:n},(_,i)=>seed(i)),answer:'reference answer',...extra});
  const cases=[mk('reference',request(3),[]),mk('empty',request(0),['boundary:empty']),mk('max',request(200),['boundary:max']),
    mk('no-ticket',{query:{text:'reference'},candidates:[]},[],'QUERY_REJECTED'),mk('not-json','not json',[],'STAGE_INPUT_INVALID')];
  const manifest:ReferencePack['manifest']={packId:commitCapability,contract:{contractId:commitCapability,version:1,capability:commitCapability,inputSchemas:['shopping.commit-request'],outputSchemas:['shopping.commit-receipt'],
    sideEffectPolicy:'IDEMPOTENT_WRITE',interruptibility:'CANCEL_RESTART',maxNonPreemptibleMs:null,serviceId,parameterRole:'EXECUTION'},
    executorIds:[serviceExecutorId],model:null,suiteId:commitCapability+'.dry-run-reference',qualityThreshold:1,resourceLimit:[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:67108864}]};
  if(!validCapabilityPackV2(manifest))throw Error('COMMIT_PACK_INVALID');
  const pack:ReferencePack={manifest,cases,maxOutputBytes:8192,dryRunEvaluation:true,evaluate:async(c,bytes)=>{try{const o=JSON.parse(bytes.toString('utf8'));if(!validCommitReceipt(o))return 0;return score({input:JSON.parse(c.input.toString('utf8'))},o);}catch{return 0;}}};
  validateCoverage(manifest,cases);return pack;
}
stageBuilders[commitCapability]=commitPack;
