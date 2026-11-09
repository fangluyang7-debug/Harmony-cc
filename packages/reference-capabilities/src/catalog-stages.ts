import {validCapabilityPackV2} from '@harmony/scheduler-core';
import type {ReferenceCase,ReferencePack} from './index';
import {propertyPack} from './evaluation';
import {validateCoverage} from './coverage';
import {serviceExecutorId,validCandidateList,stageBuilders} from './vector-search';

/**
 * Read-only shopping stages a business service provides as ordinary capabilities:
 *   catalog.price-stock.v1  candidate.list | catalog.item-refs -> catalog.prices
 *   rank.v1                 candidate.seeds -> candidate.seeds
 * Reference cases are synthetic; evaluation checks invariants that must hold for any catalogue,
 * so qualification never depends on fixture data existing in the real database.
 */
export const priceStockCapability='catalog.price-stock.v1';
export const rankCapability='rank.v1';
const config={id:'standard',threads:1,batchSize:1,quality:'standard'} as const;
const maxItems=200;
const money=/^\d{1,100}(\.\d{1,100})?$/;
const stock=['in_stock','out_of_stock','unknown'];
const text=(v:unknown,max=2048)=>typeof v==='string'&&v.length>0&&v.length<=max;

export interface ItemRef {productId?:string;platformName?:string;productUrl?:string;score?:number;}
export interface ItemRefs {items:ItemRef[];}
export interface PriceLine {productId:string|null;platformName:string|null;productUrl:string|null;score:number|null;amount:string|null;currency:string|null;stockStatus:string;catalogUpdatedAt:string|null;}
export interface Prices {priceSource:string;items:PriceLine[];}
export interface CandidateSeed {title:string;platformName:string;amount:string;currency:string;shopName:string;shopType:string;stockStatus:string;coverImageUrl:string;productUrl:string;matchSummary:object;normalizedAttributes:object;rawPayload:object;recommendationReason:string[];productPoolKey?:string|null;}
export interface Seeds {items:CandidateSeed[];}
export interface RankFilters {stockOnly?:boolean;priceMin?:string|null;priceMax?:string|null;sortRule?:string;}

const itemRef=(i:unknown):i is ItemRef=>!!i&&typeof i==='object'&&Object.keys(i as object).every(k=>['productId','platformName','productUrl','score'].includes(k))&&
  (text((i as ItemRef).productId,256)||text((i as ItemRef).platformName,128)&&text((i as ItemRef).productUrl))&&((i as ItemRef).score===undefined||Number.isFinite((i as ItemRef).score));
export function validItemRefs(v:unknown):v is ItemRefs {return !!v&&typeof v==='object'&&Object.keys(v as object).join('|')==='items'&&Array.isArray((v as ItemRefs).items)&&(v as ItemRefs).items.length<=maxItems&&(v as ItemRefs).items.every(itemRef);}
export function validPrices(v:unknown):v is Prices {
  const p=v as Prices;
  return !!p&&typeof p==='object'&&Object.keys(p).every(k=>['priceSource','items'].includes(k))&&typeof p.priceSource==='string'&&Array.isArray(p.items)&&p.items.length<=maxItems&&p.items.every(l=>!!l&&typeof l==='object'&&
    Object.keys(l).every(k=>['productId','platformName','productUrl','score','amount','currency','stockStatus','catalogUpdatedAt'].includes(k))&&
    (l.amount===null||typeof l.amount==='string'&&money.test(l.amount))&&(l.currency===null||typeof l.currency==='string')&&stock.includes(l.stockStatus)&&(l.score===null||Number.isFinite(l.score))&&
    (l.catalogUpdatedAt===null||typeof l.catalogUpdatedAt==='string'));
}
const seed=(i:unknown):i is CandidateSeed=>{const s=i as CandidateSeed;return !!s&&typeof s==='object'&&text(s.platformName,128)&&text(s.productUrl)&&typeof s.amount==='string'&&money.test(s.amount)&&stock.includes(s.stockStatus)&&typeof s.title==='string'&&Array.isArray(s.recommendationReason);};
export function validSeeds(v:unknown):v is Seeds {return !!v&&typeof v==='object'&&Object.keys(v as object).join('|')==='items'&&Array.isArray((v as Seeds).items)&&(v as Seeds).items.length<=maxItems&&(v as Seeds).items.every(seed);}
export function validRankFilters(v:unknown):v is RankFilters {
  const f=v as RankFilters;
  return !!f&&typeof f==='object'&&!Array.isArray(f)&&Object.keys(f).every(k=>['stockOnly','priceMin','priceMax','sortRule'].includes(k))&&(f.stockOnly===undefined||typeof f.stockOnly==='boolean')&&
    (f.sortRule===undefined||['relevance_desc','price_asc','price_desc'].includes(f.sortRule))&&[f.priceMin,f.priceMax].every(x=>x===undefined||x===null||typeof x==='string'&&money.test(x));
}
function compareMoney(a:string,b:string){const [aw,af='']=a.split('.'),[bw,bf='']=b.split('.');const x=aw.replace(/^0+(?=\d)/,''),y=bw.replace(/^0+(?=\d)/,'');if(x.length!==y.length)return x.length-y.length;const w=x.localeCompare(y);if(w)return w;const n=Math.max(af.length,bf.length);return af.padEnd(n,'0').localeCompare(bf.padEnd(n,'0'));}

const refsOf=(c:{input:unknown})=>{const q=c.input as {items?:ItemRef[];candidates?:ItemRef[]};return q.items??q.candidates??[];};
const priceInvariants=[
  {id:'one-line-per-item',version:1,check:(c:{input:unknown},o:Prices)=>o.items.length===refsOf(c).length},
  {id:'identity-preserved',version:1,check:(c:{input:unknown},o:Prices)=>refsOf(c).every((r,i)=>r.productId===undefined||o.items[i].productId===r.productId||o.items[i].productId===null)},
  {id:'priced-lines-have-currency',version:1,check:(_c:unknown,o:Prices)=>o.items.every(l=>(l.amount===null)===(l.currency===null))},
  {id:'unknown-when-unpriced',version:1,check:(_c:unknown,o:Prices)=>o.items.every(l=>l.amount!==null||l.stockStatus==='unknown')}
];
const rankInvariants=[
  {id:'subset',version:1,check:(c:{input:Seeds;filters:RankFilters},o:Seeds)=>o.items.length<=Math.min(30,c.input.items.length)&&o.items.every(x=>c.input.items.some(i=>i.platformName===x.platformName&&i.productUrl===x.productUrl))},
  {id:'unique',version:1,check:(_c:unknown,o:Seeds)=>new Set(o.items.map(x=>x.productPoolKey??x.platformName+':'+x.productUrl)).size===o.items.length},
  {id:'stock-filter',version:1,check:(c:{filters:RankFilters},o:Seeds)=>c.filters.stockOnly!==true||o.items.every(x=>x.stockStatus==='in_stock')},
  {id:'price-window',version:1,check:(c:{filters:RankFilters},o:Seeds)=>o.items.every(x=>(c.filters.priceMin==null||compareMoney(x.amount,c.filters.priceMin)>=0)&&(c.filters.priceMax==null||compareMoney(x.amount,c.filters.priceMax)<=0))},
  {id:'sort-rule',version:1,check:(c:{filters:RankFilters},o:Seeds)=>{const d=c.filters.sortRule==='price_asc'?1:c.filters.sortRule==='price_desc'?-1:0;return d===0||o.items.every((x,i)=>i===0||compareMoney(o.items[i-1].amount,x.amount)*d<=0);}}
];
const scorePrice=propertyPack(priceInvariants),scoreRank=propertyPack(rankInvariants);

function manifest(serviceId:string,capability:string,inputSchemas:string[],outputSchema:string):ReferencePack['manifest']{
  const m:ReferencePack['manifest']={packId:capability,contract:{contractId:capability,version:1,capability,inputSchemas,outputSchemas:[outputSchema],sideEffectPolicy:'PURE',interruptibility:'CANCEL_RESTART',maxNonPreemptibleMs:null,serviceId,parameterRole:'EXECUTION'},
    executorIds:[serviceExecutorId],model:null,suiteId:capability+'.reference',qualityThreshold:1,resourceLimit:[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:67108864}]};
  if(!validCapabilityPackV2(m))throw Error('STAGE_PACK_INVALID');return m;
}
const serviceIdValid=(s:string)=>typeof s==='string'&&/^[a-zA-Z0-9_.:-]{1,128}$/.test(s);
const sample=(n:number)=>Array.from({length:n},(_,i)=>({productId:'reference-product-'+i,score:1-i/n}));

export function priceStockPack(serviceId:string):ReferencePack {
  if(!serviceIdValid(serviceId))throw Error('SERVICE_ID_INVALID');
  const schema='schema:catalog.item-refs',mk=(id:string,input:unknown,covers:string[],errorCode?:string):ReferenceCase=>({id,input:Buffer.from(typeof input==='string'?input:JSON.stringify(input)),parameters:'{}',config:{...config},maxOutputBytes:65536,covers:[...new Set([schema,'schema:candidate.list',...covers])],
    expect:errorCode?{kind:'REJECT',errorCode}:{kind:'OUTPUT'},...(errorCode?{}:{expected:{invariants:priceInvariants.map(({id,version})=>({id,version}))}})});
  const cases=[mk('reference',{items:sample(3)},[]),mk('by-url',{items:[{platformName:'reference-platform',productUrl:'https://reference.invalid/p/1'}]},[]),
    mk('candidate-list',{indexSpaceId:'reference',indexVersion:'reference',model:{modelId:'reference',version:'1',weightsHash:'0'.repeat(64),preprocessVersion:'reference',embeddingKind:'image',dimension:2,dtype:'float32',normalization:'l2'},candidates:sample(2),scoreMeaning:'COSINE_SIMILARITY'},[]),
    mk('empty',{items:[]},['boundary:empty']),mk('max',{items:sample(maxItems)},['boundary:max']),
    mk('invalid-item',{items:[{score:1}]},[],'QUERY_REJECTED'),mk('not-json','not json',[],'STAGE_INPUT_INVALID')];
  const m=manifest(serviceId,priceStockCapability,['candidate.list','catalog.item-refs'],'catalog.prices');
  const pack:ReferencePack={manifest:m,cases,maxOutputBytes:65536,evaluate:async(c,bytes)=>{try{const o=JSON.parse(bytes.toString('utf8'));if(!validPrices(o))return 0;return scorePrice({input:JSON.parse(c.input.toString('utf8'))},o);}catch{return 0;}}};
  validateCoverage(m,cases);return pack;
}
export function rankPack(serviceId:string):ReferencePack {
  if(!serviceIdValid(serviceId))throw Error('SERVICE_ID_INVALID');
  const seedOf=(i:number,amount:string,stockStatus='in_stock'):CandidateSeed=>({title:'reference '+i,platformName:'reference-platform',amount,currency:'CNY',shopName:'reference',shopType:'reference',stockStatus,coverImageUrl:'https://reference.invalid/i/'+i,productUrl:'https://reference.invalid/p/'+i,matchSummary:{},normalizedAttributes:{},rawPayload:{},recommendationReason:[]});
  const schema='schema:candidate.seeds',mk=(id:string,input:unknown,filters:RankFilters,covers:string[],errorCode?:string):ReferenceCase=>({id,input:Buffer.from(typeof input==='string'?input:JSON.stringify(input)),parameters:JSON.stringify(filters),config:{...config},maxOutputBytes:65536,covers:[...new Set([schema,...covers])],
    expect:errorCode?{kind:'REJECT',errorCode}:{kind:'OUTPUT'},...(errorCode?{}:{expected:{invariants:rankInvariants.map(({id,version})=>({id,version}))}})});
  const mixed={items:[seedOf(0,'299.00'),seedOf(1,'99.5','out_of_stock'),seedOf(2,'1299'),seedOf(2,'1299'),seedOf(3,'0.99')]};
  const cases=[mk('reference',mixed,{},[]),mk('price-asc',mixed,{sortRule:'price_asc'},[]),mk('price-desc-stock',mixed,{sortRule:'price_desc',stockOnly:true},[]),mk('window',mixed,{priceMin:'50',priceMax:'500'},[]),
    mk('empty',{items:[]},{},['boundary:empty']),mk('max',{items:Array.from({length:maxItems},(_,i)=>seedOf(i,String(i+1)))},{},['boundary:max']),
    mk('invalid-item',{items:[{title:'x'}]},{},[],'QUERY_REJECTED'),mk('not-json','not json',{},[],'STAGE_INPUT_INVALID')];
  const m=manifest(serviceId,rankCapability,['candidate.seeds'],'candidate.seeds');
  const pack:ReferencePack={manifest:m,cases,maxOutputBytes:65536,evaluate:async(c,bytes)=>{try{const o=JSON.parse(bytes.toString('utf8')),f=JSON.parse(c.parameters);if(!validSeeds(o)||!validRankFilters(f))return 0;return scoreRank({input:JSON.parse(c.input.toString('utf8')),filters:f},o);}catch{return 0;}}};
  validateCoverage(m,cases);return pack;
}
/** Capabilities a business service can declare in the shared service pack file. */
export const stagePacks:Record<string,(serviceId:string)=>ReferencePack>={[priceStockCapability]:priceStockPack,[rankCapability]:rankPack};
Object.assign(stageBuilders,stagePacks);
export {validCandidateList};
