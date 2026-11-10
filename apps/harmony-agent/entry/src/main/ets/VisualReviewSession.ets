import { common } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { image } from '@kit.ImageKit';
import { fileIo } from '@kit.CoreFileKit';
import { preferences } from '@kit.ArkData';
import { util } from '@kit.ArkTS';
import { DeviceProfileV2, HarmonySdkPort, SchedulerSdk, TrustedCoordinator, ReviewImage, ReviewRun, ReviewTarget, ReviewPort, runVisualReview, packVisualRaw, hash, bytes, text, monotonic } from 'scheduler';
import { openAgent } from './AgentRuntime';
import { ReviewSdkPort } from './ReviewSdkPort';
interface Price {amount:string|number;currency:string;}
interface Product {candidateItemId:string;title:string;coverImageUrl:string;price:Price;}
interface ProductList {items:Product[];}
interface SearchData {runtimeRunId:string;candidates:ProductList;}
interface SearchEnvelope {success:boolean;data:SearchData;}
interface AuthData {accessToken:string;}
interface AuthEnvelope {success:boolean;data:AuthData;}
interface Registration extends TrustedCoordinator {registrationId:string;code:string;}
interface SavedApp {trust:TrustedCoordinator;credential:string;}
interface Exchange {credential:string;}
interface Profiles {profiles:DeviceProfileV2[];}
export interface ReviewProduct {id:string;title:string;price:string;file:string;sha256:string;}
export interface ReviewGallery {id:string;query:string;sourceRunId:string;acquisitionMs:number;products:ReviewProduct[];}
export interface ReviewResultView {galleryId:string;summary:string;resultHash:string;}
const origin='https://api-server-production-0135.up.railway.app';
function read(file:string):Uint8Array{const f=fileIo.openSync(file,fileIo.OpenMode.READ_ONLY);try{const n=fileIo.statSync(f.fd).size;if(n<1||n>8388608)throw Error('REVIEW_FILE_SIZE');const b=new ArrayBuffer(n);if(fileIo.readSync(f.fd,b)!==n)throw Error('REVIEW_FILE_READ');return new Uint8Array(b);}finally{fileIo.closeSync(f);}}
function write(file:string,data:Uint8Array):void{const f=fileIo.openSync(file,fileIo.OpenMode.CREATE|fileIo.OpenMode.WRITE_ONLY|fileIo.OpenMode.TRUNC);try{if(fileIo.writeSync(f.fd,data.slice().buffer as ArrayBuffer)!==data.length)throw Error('REVIEW_FILE_WRITE');}finally{fileIo.closeSync(f);}}
async function request(url:string,body:string|null,token:string='',binary:boolean=false):Promise<Uint8Array>{
 if(!url.startsWith('https://'))throw Error('HTTPS_REQUIRED');const client=http.createHttp(),headers:Record<string,string>={'Content-Type':'application/json'};if(token)headers['Authorization']='Bearer '+token;
 try{const r=await client.request(url,{method:body===null?http.RequestMethod.GET:http.RequestMethod.POST,header:headers,extraData:body===null?'':body,expectDataType:binary?http.HttpDataType.ARRAY_BUFFER:http.HttpDataType.STRING,connectTimeout:10000,readTimeout:120000,maxLimit:8388608});if(r.responseCode<200||r.responseCode>=300)throw Error('SHOPPING_HTTP_'+r.responseCode);return typeof r.result==='string'?bytes(r.result):new Uint8Array(r.result as ArrayBuffer);}finally{client.destroy();}
}
export class VisualReviewSession {
 gallery:ReviewGallery|null=null;
 runs:ReviewRun[]=[];
 targets:ReviewTarget[]=[];
 phone:ReviewTarget|null=null;
 status='请先连接协作空间';
 private context:common.UIAbilityContext;
 private port:HarmonySdkPort|null=null;
 private stop=false;
 private saveWork:Promise<void>=Promise.resolve();
 private root:string;
 constructor(context:common.UIAbilityContext){this.context=context;this.root=context.filesDir+'/visual-review';try{fileIo.mkdirSync(this.root);}catch(_){} }
 async connect():Promise<void>{
  const agent=await openAgent(this.context,null),until=Date.now()+20000;while(!agent.isConnected()&&Date.now()<until)await new Promise<void>(resolve=>setTimeout(resolve,250));
  if(!agent.isConnected())throw Error('请先在 Harmony 协作空间加入群组并开启贡献');
  const store=await preferences.getPreferences(this.context,{name:'soleai-visual-'+agent.displayHolderId()}),saved=await store.get('installation','') as string;
  if(saved){const installed=JSON.parse(saved) as SavedApp;this.port=await HarmonySdkPort.open(this.context,installed.trust,installed.credential);}
  else{
   if(await store.get('pending',false) as boolean)throw Error('应用注册待对账，请勿重复授权');
   const invitation=JSON.parse(await agent.registerApplication({label:'SoleAI · 商品图像复核',allowedContracts:['image.visual-match.v1'],maxConcurrent:8,resources:[{resourcePoolId:'cpu',amount:8},{resourcePoolId:'ram',amount:1073741824}],offlineBase:[],onlineExtra:[]})) as Registration;
   await store.put('pending',true);await store.flush();this.port=await HarmonySdkPort.open(this.context,invitation);
   const exchanged=JSON.parse(await this.port.exchange(invitation.registrationId,invitation.code)) as Exchange;
   const installation:SavedApp={trust:{address:invitation.address,certificate:invitation.certificate,fingerprint:invitation.fingerprint},credential:exchanged.credential};await store.put('installation',JSON.stringify(installation));await store.put('pending',false);await store.flush();
  }
  await this.port.request('/v2/apps/me',null);await this.refresh();
  try{this.gallery=JSON.parse(text(read(this.root+'/gallery.json'))) as ReviewGallery;this.runs=JSON.parse(text(read(this.root+'/runs.json'))) as ReviewRun[];}catch(_){}
  this.status='已连接 · '+this.targets.length+' 台其他设备可选；手机能力由 SDK 提交时复核';
 }
 async refresh():Promise<void>{
  if(!this.port)throw Error('APP_NOT_CONNECTED');const agent=await openAgent(this.context,null),data=JSON.parse(await this.port.request('/v2/devices',null)) as Profiles;this.phone=null;this.targets=[];
  for(const p of data.profiles){const executor=p.executors.find(e=>e.contract.capability==='image.visual-match.v1');if(!executor||p.energyGate||p.ownerActivity.value!=='IDLE'||p.foreground.sampledAt+p.foreground.ttlMs<=Date.now())continue;
   const slots=Math.min(8,Math.max(1,Math.floor(p.pools.find(pool=>pool.kind==='CPU_SLOTS')?.admissionLimit.value??1))),target:ReviewTarget={deviceId:p.deviceId,targetId:executor.target.targetId,slots};
   if(p.holderInstanceId===agent.displayHolderId())this.phone=target;else this.targets.push(target);
  }
 }
 async acquire(query:string,progress:(value:string)=>void):Promise<void>{
  if(!this.port)throw Error('请先连接');query=query.trim();if(!query||query.length>200)throw Error('请输入购物需求');
  const started=monotonic();progress('购物 Agent 正在检索真实商品');const auth=JSON.parse(text(await request(origin+'/api/v1/auth/guest','{}'))) as AuthEnvelope;
  if(!auth.success||!auth.data?.accessToken)throw Error('SHOPPING_AUTH_FAILED');
  const response=JSON.parse(text(await request(origin+'/api/v1/sessions/text',JSON.stringify({message:query,entrySource:'test_app'}),auth.data.accessToken))) as SearchEnvelope;
  if(!response.success||!response.data?.runtimeRunId||!Array.isArray(response.data.candidates?.items))throw Error('SHOPPING_CANDIDATES_INVALID');
  const gallery:ReviewGallery={id:util.generateRandomUUID(true),query,sourceRunId:response.data.runtimeRunId,acquisitionMs:0,products:[]},seen=new Set<string>();let size=0;
  for(const product of response.data.candidates.items.slice(0,30)){progress('下载商品原图 '+(gallery.products.length+1)+'/最多 30');const data=await request(product.coverImageUrl,null,'',true),digest=hash(data);if(seen.has(digest))continue;seen.add(digest);size+=data.length;if(size>67108864)throw Error('GALLERY_TOTAL_SIZE_LIMIT');const id='p'+gallery.products.length,file=this.root+'/'+gallery.id+'-'+id+'.img';write(file,data);gallery.products.push({id,title:product.title,price:String(product.price.amount),file,sha256:digest});}
  if(gallery.products.length<3)throw Error('至少需要三张不同商品图片');gallery.acquisitionMs=monotonic()-started;this.gallery=gallery;this.runs=[];write(this.root+'/gallery.json',bytes(JSON.stringify(gallery)));write(this.root+'/runs.json',bytes('[]'));
 }
 private async images():Promise<ReviewImage[]>{
  if(!this.gallery)throw Error('请先获取商品');const images:ReviewImage[]=[];
  for(const product of this.gallery.products){if(this.stop)throw Error('USER_CANCELLED');const original=read(product.file);if(hash(original)!==product.sha256)throw Error('SOURCE_IMAGE_CHANGED');const source=image.createImageSource(original.slice().buffer as ArrayBuffer);let pixels:image.PixelMap|null=null;
   try{const info=await source.getImageInfo();if(info.size.width*info.size.height>16777216)throw Error('IMAGE_DIMENSIONS');const scale=Math.min(1,512/Math.max(info.size.width,info.size.height));pixels=await source.createPixelMap({desiredSize:{width:Math.round(info.size.width*scale),height:Math.round(info.size.height*scale)},desiredPixelFormat:image.PixelMapFormat.RGBA_8888});const actual=await pixels.getImageInfo(),width=actual.size.width,height=actual.size.height,rgba=new Uint8Array(width*height*4),rgb=new Uint8Array(width*height*3);await pixels.readPixelsToBuffer(rgba.buffer as ArrayBuffer);for(let i=0;i<width*height;i++){rgb[i*3]=rgba[i*4];rgb[i*3+1]=rgba[i*4+1];rgb[i*3+2]=rgba[i*4+2];}images.push({id:product.id,width,height,rgb});}finally{await pixels?.release();await source.release();}
  }return images;
 }
 async run(mode:string,computerId:string,update:(run:ReviewRun)=>void):Promise<ReviewRun>{
  await this.refresh();if(!this.port||!this.phone)throw Error('手机计算能力尚未就绪，请保持本页前台并等待校准');const computer=this.targets.find(t=>t.deviceId===computerId)??null;
  if(mode==='TEAM'&&!computer)throw Error('请连接并选择另一台计算设备');this.stop=false;const observed=new ReviewSdkPort(this.port),sdk=new SchedulerSdk(observed),session=this;
  const adapter:ReviewPort={sdk,now:()=>monotonic(),id:()=>util.generateRandomUUID(true),digest:async(data:Uint8Array):Promise<string>=>hash(data),load:()=>session.images(),pack:packVisualRaw,encode:bytes,decode:text,cancelled:()=>session.stop,observeStatus:(listener)=>{observed.listener=listener;},
   save:async(run:ReviewRun):Promise<void>=>{const copy=JSON.parse(JSON.stringify(run)) as ReviewRun,index=session.runs.findIndex(r=>r.id===run.id);if(index<0)session.runs.push(copy);else session.runs[index]=copy;const snapshot=JSON.stringify(session.runs);session.saveWork=session.saveWork.then(()=>{write(session.root+'/runs.json',bytes(snapshot));});await session.saveWork;update(copy);}};
  return runVisualReview(adapter,this.phone,computer,mode);
 }
 cancel():void{this.stop=true;}
 resultView():ReviewResultView{
  const last=this.runs[this.runs.length-1];if(!this.gallery||!last)throw Error('尚无结果');let summary=this.gallery.query+'\n'+this.gallery.products.length+' 张真实图片 · '+last.state+' · '+(last.durationMs/1000).toFixed(3)+' 秒\n'+(last.mode==='PHONE'?'手机单机':'手机和电脑分片协作')+'\n'+last.error;
  const same=this.runs.filter(r=>r.state==='SUCCEEDED'&&r.sourceHash===last.sourceHash&&r.resultHash===last.resultHash),phone=same.filter(r=>r.mode==='PHONE').pop(),team=same.filter(r=>r.mode==='TEAM').pop();if(phone&&team)summary+='\n同输入单次对照：手机 '+(phone.durationMs/1000).toFixed(3)+' s；双机 '+(team.durationMs/1000).toFixed(3)+' s；'+(phone.durationMs/team.durationMs).toFixed(2)+'×（不代表稳定多轮性能）';
  for(const pair of last.pairs.slice().sort((a,b)=>b.scoreMillion-a.scoreMillion).slice(0,3))summary+='\n外观近似 '+(pair.scoreMillion/10000).toFixed(1)+'：'+this.gallery.products.find(p=>p.id===pair.a)?.title+' / '+this.gallery.products.find(p=>p.id===pair.b)?.title;
  return {galleryId:this.gallery.id,summary,resultHash:last.resultHash};
 }
}
