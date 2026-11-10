// Two local PC hosts stand in for phone/computer. Functional rehearsal only;
// never report these timings as phone or multi-machine performance.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),zlib=require('node:zlib');
const {randomUUID,createHash}=require('node:crypto'),{performance}=require('node:perf_hooks');
const root=path.resolve(__dirname,'..');
const {CpuHost}=require('../services/pc-agent/dist/host'),{DurableLedger}=require('../services/pc-agent/dist/durable-ledger');
const {SchedulerSdk}=require('@harmony/scheduler-client'),{nodeSdkPort}=require('@harmony/scheduler-client/dist/node');
const {runVisualReview}=require('./lib/visual-review-core.cjs'),{loadImages}=require('./shopping-visual-agent.cjs'),{acquire}=require('./acquire-shopping-images.cjs');
const hash=b=>createHash('sha256').update(b).digest('hex');
async function openRehearsal(){
 const cwd=process.cwd();process.chdir(path.join(root,'services/coordinator'));
 let r;try{r=await require('../services/coordinator/test/helpers.cjs').runtime({cpuHost:true});}finally{process.chdir(cwd);}
 const group=randomUUID(),hosts=[],connections=[],targets=[],errors=[];
 try{
  for(let i=0;i<2;i++){
   const device=randomUUID(),holder=randomUUID(),slots=i===0?2:4,capacity=[{resourcePoolId:'cpu',amount:slots},{resourcePoolId:'ram',amount:slots*134217728}];
   const invite=await r.auth.invite(group,randomUUID(),device,r.url),owner=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:holder});
   await r.allotments.confirmDevice(device,capacity,[{groupId:group,holderInstanceId:holder,appInstanceId:null}]);
   const directory=path.join(r.config.dataDir,'host-'+i),identity={groupId:group,deviceId:device,holderInstanceId:holder,appInstanceId:null},ledger=await DurableLedger.open(directory,identity,invite.certificate);await ledger.close();
   const connection={address:r.url,certificate:invite.certificate,fingerprint:invite.fingerprint,credential:owner.credential,domain:'SIMULATED'};
   const host=await CpuHost.open({directory,identity,connection,controlIntervalMs:1000,contribution:{ownerMode:'dedicated',maxCpuThreads:slots,maxMemoryBytes:slots*134217728,reserveMemoryBytes:0}},e=>errors.push(String(e)));host.start();hosts.push(host);connections.push({connection,owner});targets.push({deviceId:device,targetId:'',slots});
  }
  const end=Date.now()+180000;let ready=false;
  while(Date.now()<end){try{const candidates=(await r.snapshots.build(group)).snapshot.candidates;for(const t of targets){const c=candidates.find(c=>c.deviceId===t.deviceId&&c.capability==='image.visual-match.v1');if(c)t.targetId=c.targetId;}if(targets.every(t=>t.targetId)){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,500));}
  if(!ready)throw Error('LOCAL_HOSTS_NOT_READY '+errors.slice(-4).join('|'));
  const invitation=await r.apps.register(connections[0].owner.peer,{label:'SoleAI local rehearsal',allowedContracts:['image.visual-match.v1'],maxConcurrent:6,resources:[{resourcePoolId:'cpu',amount:6},{resourcePoolId:'ram',amount:805306368}],offlineBase:[],onlineExtra:[]},r.url),app=await r.apps.exchange({registrationId:invitation.registrationId,code:invitation.code});
  const port=nodeSdkPort({...connections[0].connection,credential:app.credential}),runs=[];
  return {r,targets,runs,errors,async run(manifest,directory,mode,onUpdate=()=>{}){
   const sdk=new SchedulerSdk(port);return runVisualReview({sdk,now:()=>performance.now(),id:randomUUID,digest:async b=>hash(b),load:()=>loadImages(manifest,directory),pack:async raw=>{const compressed=zlib.deflateSync(raw,{level:1}),header=Buffer.alloc(8);header.write('HVG1');header.writeUInt32LE(raw.length,4);return new Uint8Array(Buffer.concat([header,compressed]));},encode:s=>new TextEncoder().encode(s),decode:b=>new TextDecoder().decode(b),cancelled:()=>false,save:async run=>{const copy=JSON.parse(JSON.stringify(run)),index=runs.findIndex(r=>r.id===run.id);if(index<0)runs.push(copy);else runs[index]=copy;onUpdate(copy);}},targets[0],targets[1],mode);
  },async audit(run){const rows=[];for(const j of run.jobs){const attempts=await r.db.attempt.findMany({where:{workflowId:j.id}}),receipt=await r.db.receipt.findUnique({where:{id:j.id}});rows.push({id:j.id,attempts:attempts.length,committed:receipt?.committed===true,settled:attempts.length===1&&JSON.parse(attempts[0].recordJson).resourcesSettled===true});}return rows;},async close(){for(const host of hosts)await host.close();await r.close();}};
 }catch(e){for(const h of hosts)await h.close().catch(()=>{});await r.close();throw e;}
}
module.exports={openRehearsal};
if(require.main===module)(async()=>{
 const session=await openRehearsal(),directory=path.join(root,'.test/soleai-review-'+Date.now());fs.mkdirSync(directory,{recursive:true});let manifest=null,busy=false,message='已连接两个本地替身，尚未读取任务图片';
 const server=http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1');res.setHeader('Cache-Control','no-store');
  if(req.method==='GET'&&url.pathname==='/'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(fs.readFileSync(path.join(root,'scripts/soleai-review-rehearsal.html')));}
  if(req.method==='GET'&&url.pathname==='/state'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({busy,message,targets:session.targets,runs:session.runs,source:manifest?{query:manifest.query,sourceRunId:manifest.sourceRunId,images:manifest.images.length}:null}));}
  if(req.method==='POST'&&['/acquire','/phone','/team'].includes(url.pathname)){
   if(req.headers.origin!=='http://'+req.headers.host)throw Error('ORIGIN_REQUIRED');if(busy)throw Error('BUSY');let body='';for await(const part of req){body+=part;if(body.length>4096)throw Error('BODY_LIMIT');}const input=JSON.parse(body||'{}');
   if(url.pathname!=='/acquire'&&!manifest)throw Error('请先获取商品');busy=true;res.end(JSON.stringify({accepted:true}));
   (async()=>{try{if(url.pathname==='/acquire'){message='正在检索并下载真实商品原图';const folder=path.join(directory,randomUUID());manifest=await acquire('https://api-server-production-0135.up.railway.app',folder,String(input.query||'500元以内的运动鞋'));manifest.directory=folder;session.runs.splice(0);message='真实商品已到来源端；未预放到两个执行宿主';}else{const result=await session.run(manifest,manifest.directory,url.pathname==='/phone'?'PHONE':'TEAM',run=>{message=run.state+' · '+run.jobs.filter(j=>j.state==='SUCCEEDED').length+'/'+run.jobs.length;fs.writeFileSync(path.join(directory,'runs.json'),JSON.stringify(session.runs,null,2));});const audit=await session.audit(result);fs.writeFileSync(path.join(directory,result.id+'-audit.json'),JSON.stringify(audit,null,2));message=result.state+(result.error?' · '+result.error:' · 结果校验完成');}}catch(e){message=e.message;}finally{busy=false;}})();return;
  }res.statusCode=404;res.end('Not found');
 }catch(e){res.statusCode=400;res.end(JSON.stringify({error:e.message}));}});
 server.listen(0,'127.0.0.1',()=>{const url='http://127.0.0.1:'+server.address().port;fs.writeFileSync(path.join(root,'.test/soleai-review-rehearsal.json'),JSON.stringify({url,directory}));console.log('Local rehearsal ready: '+url);if(process.argv.includes('--open')&&process.platform==='win32')require('node:child_process').execFile('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true},()=>{});});
 process.on('SIGINT',async()=>{server.close();await session.close();process.exit();});
})().catch(e=>{console.error(e.message);process.exitCode=1;});
