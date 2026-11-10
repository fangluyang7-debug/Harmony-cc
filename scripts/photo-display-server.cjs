// Display-only receiver. Deliberately imports no scheduler, worker or model runtime.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {PhotoDisplayRecords,nativeRun,cooperativeRun,summary}=require('./photo-display-records.cjs');
const {PhotoCoordinatorObserver}=require('./photo-display-coordinator.cjs');
const web=path.resolve(__dirname,'../apps/team-space-web');
const local=req=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
function createDisplayState(initial){
 const empty=(revision=0,generation=0)=>({revision,generation,seq:0,status:'WAITING',runId:'',inputs:[],results:[],events:[],connected:false,receivedAt:null});
 let state=initial??empty();
 function apply(e){
  if(!Number.isSafeInteger(e.seq)||e.seq<1)throw Error('INVALID_SEQUENCE');
  if(e.seq<=state.seq)return state;
  const types=['PICKING','SELECTED','START','PROGRESS','RESULT','FINISH','FAILED'];
  if(!types.includes(e.type)||typeof e.runId!=='string'||e.runId.length>80)throw Error('INVALID_EVENT');
  const next=structuredClone(state);
  if(e.type==='PICKING')Object.assign(next,{status:'PICKING',runId:'picking-'+(state.revision+1),startedAt:Date.now(),inputs:[],results:[],phase:'',completed:0,total:1,durationMs:null,error:null});
  if(e.type==='SELECTED'){
   if(!Array.isArray(e.inputs)||e.inputs.length>8)throw Error('INVALID_INPUTS');
   for(const input of e.inputs){if(!/^[a-f0-9]{64}$/.test(input.hash)||!Number.isSafeInteger(input.width)||!Number.isSafeInteger(input.height)||input.width<1||input.height<1||typeof input.preview!=='string'||input.preview.length>200000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(input.preview))throw Error('INVALID_PREVIEW');}
   Object.assign(next,{runId:e.runId,inputs:e.inputs,results:[],events:[],durationMs:null,phase:'',completed:0,total:1,status:'SELECTED',error:null,startedAt:Date.now()});
  }else if(!['PICKING'].includes(e.type)&&e.runId!==next.runId)throw Error('RUN_MISMATCH');
  if(e.type==='START'){if(!next.inputs.length)throw Error('NO_INPUT');Object.assign(next,{status:'RUNNING',startedAt:Date.now(),results:[],events:[],durationMs:null,phase:'分析照片',completed:0,total:1});}
  if(e.type==='PROGRESS'){
   if(next.status!=='RUNNING'||!Number.isFinite(e.completed)||!Number.isFinite(e.total)||e.completed<0||e.total<1||e.completed>e.total)throw Error('INVALID_PROGRESS');
   Object.assign(next,{phase:String(e.phase).slice(0,160),completed:e.completed,total:e.total,imageIndex:e.imageIndex});
  }
  if(e.type==='RESULT'){
   if(next.status!=='RUNNING'||!Number.isInteger(e.imageIndex)||!next.inputs[e.imageIndex])throw Error('INVALID_RESULT');
   const p=e.product,b=Buffer.from(p?.image??'','base64'),input=next.inputs[e.imageIndex];
   if(p?.format!=='png'||b.length<24||b.length>8388608||b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||crypto.createHash('sha256').update(b).digest('hex')!==p.hash||p.width!==input.width*4||p.height!==input.height*4||b.readUInt32BE(16)!==p.width||b.readUInt32BE(20)!==p.height)throw Error('RESULT_INTEGRITY');
   if(next.results.some(r=>r.imageIndex===e.imageIndex))throw Error('DUPLICATE_RESULT');
   next.results.push({imageIndex:e.imageIndex,hash:p.hash,width:p.width,height:p.height,image:p.image,receivedAt:Date.now()});
  }
  if(e.type==='FINISH'){
   if(next.status!=='RUNNING'||next.results.length!==next.inputs.length||!Number.isFinite(e.durationMs)||e.durationMs<0)throw Error('INCOMPLETE_RUN');
   Object.assign(next,{status:'SUCCEEDED',durationMs:e.durationMs,phase:'处理完成'});
  }
  if(e.type==='FAILED')Object.assign(next,{status:'FAILED',error:String(e.error).slice(0,300),durationMs:e.durationMs??null});
  next.events.push({type:e.type,seq:e.seq,runId:e.runId,phase:e.phase??null,imageIndex:e.imageIndex??null,hash:e.product?.hash??null,receivedAt:Date.now()});next.events=next.events.slice(-250);
  Object.assign(next,{seq:e.seq,revision:state.revision+1,receivedAt:Date.now(),connected:true});state=next;return state;
 }
 return {apply,get:()=>state,reset:()=>{state=empty(state.revision+1,state.generation+1);return state;}};
}
async function startDisplay({host,port=7460,dataDir,coordinatorConfig,coordinatorProvider}={}){
 const interfaces=Object.entries(os.networkInterfaces()).flatMap(([name,list])=>(list??[]).filter(i=>i.family==='IPv4'&&!i.internal).map(i=>({name,address:i.address})));
 host??=(interfaces.find(i=>/WLAN|Wi-Fi|Wireless|无线/i.test(i.name))??interfaces[0])?.address;
 if(!host)throw Error('LAN_ADDRESS_REQUIRED');
 const records=new PhotoDisplayRecords(dataDir),observer=new PhotoCoordinatorObserver();
 const sessionFile=dataDir&&path.join(dataDir,'session.json');let restored={};
 if(sessionFile&&fs.existsSync(sessionFile))restored=JSON.parse(fs.readFileSync(sessionFile));
 let key=restored.key??crypto.randomBytes(18).toString('hex'),hiddenBefore=restored.hiddenBefore??0;const store=createDisplayState(restored.state);records.save(store.get());
 const persist=()=>{if(sessionFile){fs.writeFileSync(sessionFile+'.tmp',JSON.stringify({key,state:store.get(),hiddenBefore}));fs.renameSync(sessionFile+'.tmp',sessionFile);}};
 persist();
 if(coordinatorConfig){const config=JSON.parse(fs.readFileSync(coordinatorConfig));try{await observer.connect(config.desktop,config.group,config.followCurrent??false);}catch(e){observer.error=e.message;}}
 const visible=r=>(r.createdAt??r.updatedAt??0)>hiddenBefore;
 const nativeRows=()=>{const rows=new Map(records.list().map(s=>[s.runId,s]));if(store.get().runId)rows.set(store.get().runId,store.get());return [...rows.values()].map(nativeRun).filter(visible);};
 const nativeState=id=>store.get().runId===id?store.get():records.get(id);
 const detail=async id=>{if(id.startsWith('local:')){const s=nativeState(id.slice(6));if(!s||!visible(nativeRun(s)))throw Error('RUN_NOT_FOUND');return nativeRun(s);}if(id.startsWith('coop:')){const r=cooperativeRun(await observer.run(id.slice(5)),observer.devices);if(!visible(r))throw Error('RUN_NOT_FOUND');return r;}throw Error('RUN_NOT_FOUND');};
 const session=()=>({invitation:`http://${host}:${server.address().port}/#display=${key}`,displayOnly:true,generation:store.get().generation});
 const assets={'/':'photo-display.html','/photo-display.html':'photo-display.html','/photo-display.js':'photo-display.js','/photo.css':'photo.css','/photo-display.css':'photo-display.css','/fonts/harmony-ui.woff':'fonts/harmony-ui.woff','/qrcode.js':'qrcode.js','/photo-display-compare.mjs':'photo-display-compare.mjs'};
 const server=http.createServer(async(req,res)=>{
  const json=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  try{
   if(req.url==='/event'||req.url==='/connect'){
    if(req.method!=='POST'||req.headers['x-display-key']!==key)return json(403,{error:'DISPLAY_KEY_INVALID'});
    let size=0,parts=[];for await(const chunk of req){size+=chunk.length;if(size>12000000)return json(413,{error:'EVENT_TOO_LARGE'});parts.push(chunk);}
    // A reset may have happened while an old phone request was still uploading.
    if(req.headers['x-display-key']!==key)return json(403,{error:'DISPLAY_KEY_INVALID'});
    if(req.url==='/connect')return json(200,{displayOnly:true,nextSeq:store.get().seq+1});
    const state=store.apply(JSON.parse(Buffer.concat(parts).toString()));records.save(state);if(['SUCCEEDED','FAILED','SELECTED'].includes(state.status))persist();return json(200,{seq:state.seq});
   }
   if(!local(req)||req.headers['sec-fetch-site']==='cross-site')return json(403,{error:'LOCAL_VIEWER_ONLY'});
   if(req.url==='/reset'&&req.method==='POST'){
    if(req.headers.origin!==`http://${req.headers.host}`||req.headers['x-display-reset']!=='1')return json(403,{error:'LOCAL_RESET_REQUIRED'});
    key=crypto.randomBytes(18).toString('hex');hiddenBefore=Date.now();store.reset();persist();return json(200,{...session(),state:store.get()});
   }
   if(req.url==='/coordinator'&&req.method==='POST'){
    if(req.headers.origin!==`http://${req.headers.host}`||req.headers['x-display-config']!=='1')return json(403,{error:'LOCAL_CONFIG_REQUIRED'});
    let body='';for await(const chunk of req){body+=chunk;if(body.length>8192)throw Error('CONFIG_TOO_LARGE');}
    const config=JSON.parse(body);return json(200,await observer.connect(config.launcher,config.group));
   }
   if(req.method!=='GET')return json(405,{error:'READ_ONLY_VIEWER'});
   if(req.url==='/session')return json(200,session());
   if(req.url==='/runs'){if(coordinatorProvider){const config=coordinatorProvider();if(config&&(!observer.connection||observer.error)){try{await observer.connect(config.desktop,undefined,true);}catch(e){observer.error=e.message;}}if(!config){observer.connection=null;observer.runs=[];observer.devices=[];}}await observer.refresh();const rows=[...nativeRows(),...observer.runs.map(r=>cooperativeRun(r,observer.devices)).filter(visible)];return json(200,{generation:store.get().generation,managed:!!coordinatorProvider,coordinator:observer.status(),runs:rows.sort((a,b)=>b.createdAt-a.createdAt).map(summary)});}
   if(req.url.startsWith('/runs/'))return json(200,await detail(decodeURIComponent(req.url.slice(6))));
   if(req.url.startsWith('/images/')){const match=/^\/images\/([^/]+)\/(\d+)\/(input|result)$/.exec(req.url);if(!match)throw Error('IMAGE_NOT_FOUND');const id=decodeURIComponent(match[1]),index=Number(match[2]),kind=match[3];if(id.startsWith('local:'))await detail(id);else if(!id.startsWith('coop:')||!observer.runs.some(r=>r.id===id.slice(5)&&visible(r)))throw Error('RUN_NOT_FOUND');let image;
    if(id.startsWith('local:')){const s=nativeState(id.slice(6));if(kind==='input'){const preview=s.inputs[index]?.preview;if(!preview)throw Error('IMAGE_NOT_FOUND');image={bytes:Buffer.from(preview.split(',')[1],'base64'),type:'image/jpeg'};}else{const r=s.results.find(r=>r.imageIndex===index);if(!r)throw Error('IMAGE_NOT_FOUND');image={bytes:Buffer.from(r.image,'base64'),type:'image/png'};}}
    else image=await observer.image(id.slice(5),index,kind);
    res.writeHead(200,{'Content-Type':image.type,'Cache-Control':'private, max-age=3600'});return res.end(image.bytes);
   }
   if(req.url==='/state')return json(200,store.get());
   if(req.url==='/evidence'){const s=store.get();return json(200,{kind:'PHONE_LOCAL_DISPLAY_ONLY',executionEvidence:'SOURCE_APP_REPORTED',windowsCompute:false,...s,inputs:s.inputs.map(({preview,...i})=>i),results:s.results.map(({image,...r})=>r)});}
   const file=assets[req.url];if(!file)return json(404,{error:'NO_COMPUTE_ROUTE'});
   res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':file.endsWith('.woff')?'font/woff':'text/javascript','Cache-Control':'no-store'});fs.createReadStream(path.join(web,file)).pipe(res);
  }catch(e){json(400,{error:e.message});}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});
 return {server,store,url:`http://127.0.0.1:${server.address().port}/`,invitation:`http://${host}:${server.address().port}/#display=${key}`};
}
module.exports={startDisplay,createDisplayState};
if(require.main===module){const args=process.argv.slice(2),get=n=>args[args.indexOf(n)+1];startDisplay({host:args.includes('--host')?get('--host'):undefined,port:args.includes('--port')?Number(get('--port')):7460,dataDir:args.includes('--data-dir')?get('--data-dir'):path.resolve(__dirname,'../.test/photo-display-unified'),coordinatorConfig:args.includes('--coordinator-config')?get('--coordinator-config'):undefined}).then(r=>console.log('仅展示页面 '+r.url+' · 请在页面查看手机连接二维码')).catch(e=>{console.error(e.message);process.exitCode=1;});}
