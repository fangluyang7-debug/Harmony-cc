import type {ReferencePack,ReferenceCase} from './index';
export function validCatalogOutput(bytes:Buffer):boolean {
 try{const r=JSON.parse(bytes.toString());return Number.isSafeInteger(r.scanned)&&r.scanned>=0&&r.scanned<=10000&&Number.isSafeInteger(r.excluded)&&r.excluded>=0&&Array.isArray(r.items)&&r.excluded+r.items.length===r.scanned&&r.items.every((i:any)=>typeof i.id==='string'&&Number.isSafeInteger(i.priceMinor)&&i.priceMinor>=0&&Number.isSafeInteger(i.rank)&&i.rank>=0);}catch{return false;}
}
export function catalogPack():ReferencePack {
 const config={id:'standard',threads:1,batchSize:1,quality:'standard'};
 const make=(id:string,input:unknown,expected:unknown):ReferenceCase=>({id,input:Buffer.from(JSON.stringify(input)),parameters:'{}',config,maxOutputBytes:Math.max(1024,Buffer.byteLength(JSON.stringify(expected))),covers:['schema:catalog.items'],expect:{kind:'OUTPUT'},expected});
 const cases:ReferenceCase[]=[
 make('budget-ties-currency',{currency:'CNY',maxPriceMinor:50000,items:[
  {id:'over',price:'500.01',currency:'CNY',rank:0},{id:'b',price:'399',currency:'CNY',rank:2},
  {id:'a',price:'399.00',currency:'CNY',rank:1},{id:'edge',price:'500',currency:'CNY',rank:3},
  {id:'foreign',price:'1',currency:'USD',rank:4},{id:'penny',price:'0.01',currency:'CNY',rank:5}]},
  {scanned:6,excluded:2,items:[{id:'penny',priceMinor:1,rank:5},{id:'a',priceMinor:39900,rank:1},{id:'b',priceMinor:39900,rank:2},{id:'edge',priceMinor:50000,rank:3}]}),
 {...make('empty',{currency:'CNY',maxPriceMinor:0,items:[]},{scanned:0,excluded:0,items:[]}),covers:['schema:catalog.items','boundary:empty']},
 {...make('maximum-items',{currency:'CNY',maxPriceMinor:50000,items:Array.from({length:10000},(_,rank)=>({id:'max-'+rank,price:'501',currency:'CNY',rank}))},
  {scanned:10000,excluded:10000,items:[]}),covers:['schema:catalog.items','boundary:max']},
 make('one-decimal',{currency:'CNY',maxPriceMinor:100,items:[{id:'x',price:'0.1',currency:'CNY',rank:0}]},{scanned:1,excluded:0,items:[{id:'x',priceMinor:10,rank:0}]}),
 ...['-1','1.001','NaN','1e2'].map((price,i)=>({...make('invalid-price-'+i,{currency:'CNY',maxPriceMinor:50000,items:[{id:'x',price,currency:'CNY',rank:0}]},null),expect:{kind:'REJECT' as const,errorCode:'CATALOG_INVALID'}})),
 {...make('invalid-budget',{currency:'CNY',maxPriceMinor:-1,items:[]},null),expect:{kind:'REJECT',errorCode:'CATALOG_INVALID'}}
 ];
 return {manifest:{packId:'catalog.filter.v1',contract:{contractId:'catalog.filter.v1',version:1,capability:'catalog.filter.v1',inputSchemas:['catalog.items'],outputSchemas:['catalog.ranked'],sideEffectPolicy:'PURE',interruptibility:'CANCEL_RESTART',maxNonPreemptibleMs:null},executorIds:['node.cpu.v1','harmony.cpu.v1'],model:null,suiteId:'catalog.filter.reference',qualityThreshold:1,resourceLimit:[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:67108864}]},cases,maxOutputBytes:4194304,evaluate:async(test,output)=>validCatalogOutput(output)&&JSON.stringify(JSON.parse(output.toString()))===JSON.stringify(test.expected)?1:0};
}
