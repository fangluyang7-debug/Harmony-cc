import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { fileIo } from '@kit.CoreFileKit';
import { http } from '@kit.NetworkKit';
import { image } from '@kit.ImageKit';
import { util } from '@kit.ArkTS';
import { CancellationSignal, SchedulerSdk, ReviewImage, packVisualRaw, matchVisualLocal, bytes, text, hash, monotonic } from 'scheduler';
import { ShoppingResult } from '../models/ShoppingResult';
import { Product } from '../models/Product';
import { numericPrice } from './CommercePresentation';
import { cooperative, ShoppingCapacity } from './CooperativeSession';
import { matchShoppingPhoto, ShoppingCostEvidence, ShoppingComputePort, ShoppingComputeJob } from './ShoppingComputeFlow';

interface CatalogItem {id:string;price:string;currency:string;rank:number;}
interface CatalogInput {currency:string;maxPriceMinor:number;items:CatalogItem[];}
interface CatalogRank {id:string;priceMinor:number;rank:number;}
interface CatalogResult {scanned:number;excluded:number;items:CatalogRank[];}
interface CostSample {key:string;localMs:number;teamMs:number;observedAt:number;}
export interface ShoppingAudit {taskId:string;runId:string;operation:string;state:string;elapsedMs:number|null;businessMs:number;imagePreparationMs:number;reason:string;actualDevices:string[];jobIds:string[];traceIds:string[];jobs:ShoppingComputeJob[];sourceHashes:string[];resultHash:string;error:string;}
interface PendingShopping {id:string;began:number;}
class NativeShoppingPort implements ShoppingComputePort {
 sdk:SchedulerSdk|null;originTarget:string|null;originDevice:string;localConcurrency:number=4;deadline:number;
 private signal:CancellationSignal;
 private audit:ShoppingAudit;
 constructor(capacity:ShoppingCapacity,signal:CancellationSignal,deadline:number,audit:ShoppingAudit){this.sdk=capacity.sdk;this.originTarget=capacity.originTarget;this.originDevice=capacity.originDevice;this.signal=signal;this.deadline=deadline;this.audit=audit;}
 now():number{return monotonic();}
 id():string{return this.audit.taskId+'-'+util.generateRandomUUID(true);}
 encode(value:string):Uint8Array{return bytes(value);}
 decode(value:Uint8Array):string{return text(value);}
 pack(value:Uint8Array):Promise<Uint8Array>{return packVisualRaw(value);}
 local(value:Uint8Array):Promise<Uint8Array>{return matchVisualLocal(value,()=>this.cancelled()||monotonic()>=this.deadline);}
 cancelled():boolean{return this.signal.isCancellationRequested;}
 observe(job:ShoppingComputeJob):void{const index=this.audit.jobs.findIndex(j=>j.id===job.id),copy=JSON.parse(JSON.stringify(job)) as ShoppingComputeJob;if(index<0)this.audit.jobs.push(copy);else this.audit.jobs[index]=copy;}
}
class ShoppingBusinessCompute {
 private context:common.UIAbilityContext|null=null;
 private costs:CostSample[]=[];
 private audits:ShoppingAudit[]=[];
 private pending:PendingShopping[]=[];
 private writes:Promise<void>=Promise.resolve();
 private load:Promise<void>=Promise.resolve();
 initialize(context:common.UIAbilityContext):void{
  this.context=context;this.load=(async():Promise<void>=>{try{const p=await preferences.getPreferences(context,{name:'shopping-cost-v1'});this.costs=JSON.parse(await p.get('samples','[]') as string) as CostSample[];}catch(_) {this.costs=[];}})();
 }
 begin(id:string):void{this.pending.push({id,began:monotonic()});this.pending=this.pending.slice(-100);}
 failed(id:string,operation:string,state:string,reason:string,policyReasons:string[]=[]):void{
  const pending=this.pending.find(p=>p.id===id);if(this.audits.some(a=>a.taskId===id))return;
  const code=/^[A-Za-z0-9_.:-]{1,180}$/.test(reason)?reason:'SHOPPING_WORKFLOW_FAILED';
  this.audits.push({taskId:id,runId:'',operation,state,elapsedMs:pending?monotonic()-pending.began:null,businessMs:0,imagePreparationMs:0,reason:'BUSINESS_WORKFLOW_FAILED',actualDevices:[],jobIds:[],traceIds:[],jobs:[],sourceHashes:[],resultHash:'',error:code+(policyReasons.length?':'+policyReasons.filter(r=>/^[A-Za-z0-9_.:()-]{1,100}$/.test(r)).slice(0,12).join(','):'')});
  this.pending=this.pending.filter(p=>p.id!==id);this.audits=this.audits.slice(-50);this.persist();
 }
 presented(id:string):void{const pending=this.pending.find(p=>p.id===id),audit=this.audits.find(a=>a.taskId===id);if(pending&&audit){audit.elapsedMs=monotonic()-pending.began;this.persist();}this.pending=this.pending.filter(p=>p.id!==id);}
 private persist():void{
  if(!this.context)return;const context=this.context,samples=JSON.stringify(this.costs.slice(-32)),audit=JSON.stringify(this.audits.slice(-50));
  this.writes=this.writes.then(async():Promise<void>=>{const store=await preferences.getPreferences(context,{name:'shopping-cost-v1'});await store.put('samples',samples);await store.flush();
   const f=fileIo.openSync(context.filesDir+'/shopping-client-audit.json',fileIo.OpenMode.CREATE|fileIo.OpenMode.WRITE_ONLY|fileIo.OpenMode.TRUNC);try{fileIo.writeSync(f.fd,bytes(audit).buffer);}finally{fileIo.closeSync(f);}
  }).catch(()=>{});
 }
 private async decode(data:Uint8Array,id:string):Promise<ReviewImage>{
  const source=image.createImageSource(data.slice().buffer as ArrayBuffer);let pixels:image.PixelMap|null=null;
  try{const info=await source.getImageInfo();if(info.size.width*info.size.height>16777216||info.size.width<32||info.size.height<32)throw Error('SHOPPING_IMAGE_DIMENSIONS');
   const scale=Math.min(1,512/Math.max(info.size.width,info.size.height));pixels=await source.createPixelMap({desiredSize:{width:Math.max(32,Math.round(info.size.width*scale)),height:Math.max(32,Math.round(info.size.height*scale))},desiredPixelFormat:image.PixelMapFormat.RGBA_8888});
   const actual=await pixels.getImageInfo(),width=actual.size.width,height=actual.size.height,rgba=new Uint8Array(width*height*4),rgb=new Uint8Array(width*height*3);await pixels.readPixelsToBuffer(rgba.buffer as ArrayBuffer);
   for(let i=0;i<width*height;i++){rgb[i*3]=rgba[i*4];rgb[i*3+1]=rgba[i*4+1];rgb[i*3+2]=rgba[i*4+2];}return {id,width,height,rgb};
  }finally{await pixels?.release();await source.release();}
 }
 private read(uri:string):Uint8Array{const f=fileIo.openSync(uri,fileIo.OpenMode.READ_ONLY);try{const size=fileIo.statSync(f.fd).size;if(size<1||size>8388608)throw Error('SHOPPING_IMAGE_SIZE');const buffer=new ArrayBuffer(size);if(fileIo.readSync(f.fd,buffer)!==size)throw Error('FILE_READ_INCOMPLETE');return new Uint8Array(buffer);}finally{fileIo.closeSync(f);}}
 private async download(url:string,signal:CancellationSignal,deadline:number):Promise<Uint8Array>{
  if(!/^https:\/\//.test(url))throw Error('SHOPPING_IMAGE_URL');const request=http.createHttp();const cancel=signal.onCancelled(()=>request.destroy());
  try{const budget=Math.floor(deadline-monotonic());if(signal.isCancellationRequested||budget<=0)throw Error('SHOPPING_CANCELLED_OR_BUDGET');
   const response=await request.request(url,{method:http.RequestMethod.GET,expectDataType:http.HttpDataType.ARRAY_BUFFER,usingCache:false,connectTimeout:Math.min(5000,budget),readTimeout:Math.min(10000,budget)});
   if(response.responseCode!==200||!(response.result instanceof ArrayBuffer))throw Error('SHOPPING_IMAGE_DOWNLOAD');const data=new Uint8Array(response.result);if(data.length>8388608||!data.length)throw Error('SHOPPING_IMAGE_SIZE');return data;
  }finally{cancel();request.destroy();}
 }
 private async downloadPage(products:Product[],signal:CancellationSignal,deadline:number):Promise<(Uint8Array|null)[]>{
  const result:(Uint8Array|null)[]=products.map(()=>null),pending=new Map<string,Promise<Uint8Array>>();let cursor=0,total=0,stopped:Error|null=null;
  const worker=async():Promise<void>=>{while(cursor<products.length&&!stopped){const index=cursor++,url=products[index].imageUrl;if(!url)continue;
   try{if(signal.isCancellationRequested||monotonic()>=deadline)throw Error('SHOPPING_CANCELLED_OR_BUDGET');
    let request=pending.get(url);if(!request){request=this.download(url,signal,deadline).then((data:Uint8Array)=>{total+=data.length;if(total>67108864)throw Error('SHOPPING_IMAGES_TOTAL_SIZE');return data;});pending.set(url,request);}result[index]=await request;
   }catch(e){if(signal.isCancellationRequested||monotonic()>=deadline||(e as Error).message==='SHOPPING_IMAGES_TOTAL_SIZE')stopped=e as Error;}
  }};
  await Promise.all([worker(),worker(),worker()]);if(stopped)throw stopped as Error;return result;
 }
 private async rankProducts(products:Product[],signal:CancellationSignal,deadline:number,audit:ShoppingAudit):Promise<void>{
  const sdk=await cooperative.availableClient();if(!sdk||products.length===0)return;
  const currency=products[0].currency||'CNY';
  if(currency!=='CNY'||products.some(p=>(p.currency||'CNY')!==currency||!/^\d{1,9}(\.\d{1,2})?$/.test(p.price))){audit.reason='PRICE_FORMAT_REQUIRES_BUSINESS_HANDLING';return;}
  const payload:CatalogInput={currency,maxPriceMinor:99999999999,items:products.map((p:Product,index:number):CatalogItem=>({id:String(index),price:p.price,currency,rank:index}))};
  if(signal.isCancellationRequested||monotonic()>=deadline)throw Error('SHOPPING_CANCELLED_OR_BUDGET');
  const input=await sdk.registerInput(bytes(JSON.stringify(payload)),'catalog.items'),id=audit.taskId+'-'+util.generateRandomUUID(true);
  const job:ShoppingComputeJob={id,deviceId:'',traceId:'',state:'SUBMITTING'};audit.jobs.push(job);
  try{
   const task=await sdk.submit({version:3,id,outputContract:'catalog.ranked',qualityTarget:'reference',nodes:[{id:'price-ranking',capability:'catalog.filter.v1',input,parameters:'{}',dependsOn:[]}]},{requestId:id,budgetMs:Math.max(1,Math.min(30000,Math.floor(deadline-monotonic()))),resultDestination:'ORIGIN'});
   if(signal.isCancellationRequested){await task.cancel();throw Error('SHOPPING_CANCELLED');}
   const result=await task.result(Math.max(1,Math.min(30000,deadline-monotonic()))),ranked=JSON.parse(text(result.output)) as CatalogResult;
   if(ranked.scanned!==products.length||ranked.excluded!==0||ranked.items.length!==products.length||new Set<string>(ranked.items.map(r=>r.id)).size!==products.length||ranked.items.some(r=>!/^\d+$/.test(r.id)||Number(r.id)>=products.length))throw Error('CATALOG_RESULT_INVALID');
   ranked.items.forEach((r:CatalogRank,index:number)=>{products[Number(r.id)].comparisonRank=index;});
   job.deviceId=result.status.deviceId;job.traceId=result.status.traceId;job.state=result.status.state;
   audit.jobIds.push(id);audit.traceIds.push(job.traceId);audit.actualDevices.push(job.deviceId);audit.reason='COORDINATOR_PRICE_RANKING';
  }catch(e){job.state='FAILED_OR_UNCONFIRMED';job.error=(e as Error).message;throw e as Error;}
  finally{sdk.releaseInput(input);}
 }
 async complete(result:ShoppingResult,photoUri:string|undefined,signal:CancellationSignal,deadline:number):Promise<ShoppingResult>{
  await this.load;const started=monotonic(),audit:ShoppingAudit={taskId:result.taskId,runId:result.runtimeRunId,operation:result.operation,state:'SUCCEEDED',elapsedMs:null,businessMs:0,imagePreparationMs:0,reason:'LIGHT_PRICE_COMPARISON_LOCAL',actualDevices:[],jobIds:[],traceIds:[],jobs:[],sourceHashes:[],resultHash:'',error:''};
  const products=result.products;
  // Keep the most recent server result in the private app sandbox for device
  // diagnosis. No request credentials or source image bytes are persisted here.
  if(this.context){try{const file=fileIo.openSync(this.context.filesDir+'/shopping-last-response.json',fileIo.OpenMode.CREATE|fileIo.OpenMode.WRITE_ONLY|fileIo.OpenMode.TRUNC);try{fileIo.writeSync(file.fd,bytes(result.payloadJson).buffer);}finally{fileIo.closeSync(file);}}catch(_) {}}
  if(photoUri&&(!products||products.length===0))audit.reason='NO_CANDIDATES_FROM_CLOUD';
  // The ordinary price-order button consumes these ranks for both text and photo results.
  if(products){const ranked=products.slice().sort((a:Product,b:Product)=>numericPrice(a)-numericPrice(b));ranked.forEach((p:Product,index:number)=>{p.comparisonRank=index;});}
  try{if(products)await this.rankProducts(products,signal,deadline,audit);}catch(e){audit.state='PARTIAL';audit.error=(e as Error).message;audit.reason='PRICE_RANKING_UNAVAILABLE';}
  try{
   if(photoUri&&products&&products.length){
    if(signal.isCancellationRequested||monotonic()>=deadline)throw Error('SHOPPING_CANCELLED_OR_BUDGET');
    const preparation=monotonic(),queryBytes=this.read(photoUri),images:ReviewImage[]=[await this.decode(queryBytes,'query')],selected:Product[][]=[],seen=new Map<string,number>();
    audit.sourceHashes.push(hash(queryBytes));
    // A bounded first page, same in local/team modes. No input is cached or staged on another device.
    const page=products.slice(0,30),downloads=await this.downloadPage(page,signal,deadline);
    for(let candidate=0;candidate<page.length;candidate++){
     const product=page[candidate],data=downloads[candidate];if(!data)continue;
     if(signal.isCancellationRequested||monotonic()>=deadline)throw Error('SHOPPING_CANCELLED_OR_BUDGET');
     if(!product.imageUrl)continue;
     try{const digest=hash(data),same=seen.get(digest);if(same!==undefined){selected[same].push(product);continue;}
      images.push(await this.decode(data,'p'+selected.length));seen.set(digest,selected.length);selected.push([product]);audit.sourceHashes.push(digest);
     }catch(e){if(signal.isCancellationRequested||monotonic()>=deadline||(e as Error).message==='SHOPPING_IMAGES_TOTAL_SIZE')throw e as Error;}
    }
    audit.imagePreparationMs=monotonic()-preparation;
    if(images.length<2){audit.reason='NO_USABLE_CANDIDATE_IMAGE';}
    else{
     const key='query-candidates-v1:'+images.map(im=>im.width+'x'+im.height).join(','),sample=this.costs.find(c=>c.key===key&&Date.now()-c.observedAt<86400000),capacity=await cooperative.capacity();
     const evidence:ShoppingCostEvidence={localMs:sample?.localMs??0,dispatchRoundTripMs:capacity.roundTripMs,remoteAvailable:capacity.remoteAvailable&&!(sample&&sample.teamMs>0&&sample.teamMs>=sample.localMs)};
     const port=new NativeShoppingPort(capacity,signal,deadline,audit);
     const matched=await matchShoppingPhoto(images,port,evidence);audit.reason=matched.decision.reason;
     audit.actualDevices=Array.from(new Set<string>(audit.actualDevices.concat(matched.jobs.map(j=>j.deviceId).filter(id=>id.length>0))));audit.jobIds.push(...matched.jobs.filter(j=>j.traceId.length>0).map(j=>j.id));audit.traceIds.push(...matched.jobs.filter(j=>j.traceId.length>0).map(j=>j.traceId));
     for(const pair of matched.pairs){for(const product of selected[Number(pair.b.slice(1))])product.visualSimilarity=pair.scoreMillion/10000;}
     audit.resultHash=hash(bytes(JSON.stringify(matched.pairs)));
     // Visual evidence is a reference for the actual user's photo, never a same-product guarantee.
     products.sort((a:Product,b:Product)=>(b.visualSimilarity??-1)-(a.visualSimilarity??-1));
     const cost:CostSample=sample??{key,localMs:0,teamMs:0,observedAt:Date.now()};if(matched.decision.collaborate)cost.teamMs=matched.computeMs;else cost.localMs=matched.computeMs;cost.observedAt=Date.now();this.costs=this.costs.filter(c=>c.key!==key).concat([cost]).slice(-32);
    }
   }
  }catch(e){audit.state='PARTIAL';audit.error=(e as Error).message;audit.reason='PHOTO_EVIDENCE_UNAVAILABLE';
   // Cloud results remain usable. Never silently re-run ambiguous distributed work locally.
   if(signal.isCancellationRequested)throw e as Error;
  }finally{audit.businessMs=monotonic()-started;this.audits.push(audit);this.audits=this.audits.slice(-50);this.persist();}
  return result;
 }
}
export const shoppingBusiness=new ShoppingBusinessCompute();
