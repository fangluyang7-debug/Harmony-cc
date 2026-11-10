// Isolated real CPU rehearsal. It never connects to hardware or existing acceptance data.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),https=require('node:https'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),runtimeFile=path.join(root,'.test/photo-tools/runtime.json');
if(!fs.existsSync(runtimeFile))throw Error('Run node scripts/prepare-photo-runtime.cjs first');
const config=JSON.parse(fs.readFileSync(runtimeFile));process.env.HARMONY_PHOTO_MODEL=config.model;process.env.HARMONY_PHOTO_RUNNER=config.runner;
// Use the same bundled worker layout as the Windows application. Installation
// preloads code and generic model fixtures only, never a user task or its output.
const bundled=path.join(root,'.test/photo-tools/bundled');
require('esbuild').buildSync({entryPoints:[path.join(root,'services/pc-agent/src/host.ts'),path.join(root,'services/pc-agent/src/cpu-child.ts')],outdir:bundled,bundle:true,platform:'node',format:'cjs',target:'node22',external:['sharp','*.node']});
process.chdir(path.join(root,'services/coordinator'));
const {runtime}=require('../services/coordinator/test/helpers.cjs'),{photoPacks}=require('@harmony/reference-capabilities');
const {CpuHost}=require(path.join(bundled,'host.js')),{DurableLedger}=require('../services/pc-agent/dist/durable-ledger');
async function main(){
 const r=await runtime({cpuHost:true,referencePacks:photoPacks(),onError:e=>console.error('COORDINATOR',e.code||e.name,e.message?.split('\n').filter(line=>!line.includes('credential')).slice(-8).join(' '))},{COORDINATOR_WEB_DIR:path.join(root,'apps/team-space-web')});r.config.publicUrl=r.url;
 const receive=r.channel.receive.bind(r.channel);r.channel.receive=async(session,message)=>{const began=performance.now();try{return await receive(session,message);}finally{const ms=performance.now()-began;if(ms>2000)console.log('SLOW_CONTROL',JSON.parse(message).type,Math.round(ms));}};
 const plan=r.jobs.graphPlan.bind(r.jobs);r.jobs.graphPlan=async(peer,request)=>{const value=await plan(peer,request);if(!value.decision.suggestion)console.log('PLAN_REFUSAL',JSON.stringify(value.decision));return value;};
 for(const name of ['issue','acknowledge']){const original=r.allotments[name].bind(r.allotments);r.allotments[name]=async(...args)=>{try{return await original(...args);}catch(e){console.error('ALLOTMENT_DIAGNOSTIC',name,e.code||'',e.message?.split('\n').filter(line=>!line.includes('credential')).slice(-8).join(' '));throw e;}};}
 let cookie='';
 const api=(route,body)=>new Promise((resolve,reject)=>{const bytes=body===undefined?null:Buffer.from(JSON.stringify(body));const req=https.request(r.url+'/v2/spaces'+route,{ca:r.identity.cert,method:bytes?'POST':'GET',headers:{Cookie:cookie,...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{})}},res=>{if(res.headers['set-cookie'])cookie=res.headers['set-cookie'][0].split(';')[0];const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{const value=JSON.parse(Buffer.concat(chunks));res.statusCode===200?resolve(value):reject(Error(value.error));});});req.on('error',reject);req.end(bytes);});
 await api('/register',{account:crypto.randomUUID(),name:'本机验证',password:crypto.randomBytes(20).toString('hex')});const group=(await api('/',{name:'照片工作流 · 本机进程验证'})).id;
 const policy={ownerMode:'dedicated',maxCpuThreads:2,maxMemoryBytes:2147483648,reserveMemoryBytes:0},bootstrap=await api('/'+group+'/devices',{name:'Windows CPU · 本机验证',settings:policy});
 const paired=await r.auth.exchange({inviteId:bootstrap.invitation.inviteId,code:bootstrap.invitation.code,holderInstanceId:bootstrap.holderInstanceId}),identity={groupId:group,deviceId:paired.peer.deviceId,holderInstanceId:paired.peer.holderInstanceId,appInstanceId:null},directory=path.join(r.config.dataDir,'worker'),ledger=await DurableLedger.open(directory,identity,bootstrap.invitation.certificate);await ledger.close();
 await r.allotments.confirmDevice(identity.deviceId,[{resourcePoolId:'cpu',amount:policy.maxCpuThreads},{resourcePoolId:'ram',amount:policy.maxMemoryBytes}],[{groupId:group,holderInstanceId:identity.holderInstanceId,appInstanceId:null}]);
 const host=await CpuHost.open({directory,identity,connection:{address:r.url,certificate:bootstrap.invitation.certificate,fingerprint:bootstrap.invitation.fingerprint,credential:paired.credential,domain:'SIMULATED'},controlIntervalMs:15000,contribution:policy},e=>console.error('WORKER',String(e)));host.start();
 // Loopback-only preview bridge; upstream TLS uses this rehearsal's exact certificate.
 // No certificate-warning bypass, no access to production sessions or existing data.
 const preview=http.createServer((req,res)=>{const headers={...req.headers,host:new URL(r.url).host,cookie};if(headers.origin)headers.origin=r.url;
  const upstream=https.request(r.url+req.url,{ca:r.identity.cert,method:req.method,headers},reply=>{const out={...reply.headers};delete out['set-cookie'];res.writeHead(reply.statusCode,out);reply.pipe(res);});upstream.on('error',e=>{res.writeHead(502);res.end(e.message);});req.pipe(upstream);
 });await new Promise(resolve=>preview.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+preview.address().port+'/photo.html?space='+group,record={url,group,deviceId:identity.deviceId,kind:'LOCAL_PROCESS_TEST',dataDir:r.config.dataDir};
 fs.writeFileSync(path.join(root,'.test/photo-tools/rehearsal.json'),JSON.stringify(record,null,2));console.log('Local CPU rehearsal:',url);console.log('Waiting for five photo capabilities to finish real qualification.');
 const deadline=Date.now()+360000;let ready=false;while(Date.now()<deadline){try{const c=(await r.snapshots.build(group)).snapshot.candidates;ready=photoPacks().every(p=>c.some(t=>t.capability===p.manifest.contract.capability));if(ready)break;}catch{}await new Promise(resolve=>setTimeout(resolve,2000));}
 if(!ready)throw Error('PHOTO_QUALIFICATION_TIMEOUT');console.log('PHOTO_READY');
 const stop=async()=>{await host.close();await new Promise(resolve=>preview.close(resolve));await r.close();};process.once('SIGINT',()=>void stop().then(()=>process.exit(0)));
 if(process.argv.includes('--check-app')){
  // Production coordinator/main writes this public certificate for its launcher.
  fs.writeFileSync(path.join(r.config.dataDir,'coordinator-public.crt'),r.identity.cert);
  const desktop=await require('./runtime-desktop.cjs').main({openBrowser:false,role:'center'});
  // Attach the isolated coordinator/account to the actual desktop proxy. No
  // production process, console credentials or existing device is involved.
  Object.assign(desktop.control,{state:'RUNNING',mode:'center',url:r.url,coordinatorDirectory:r.config.dataDir,
   localSpace:{expiresAt:Date.now()+3600000,cookie:Promise.resolve(cookie)}});
  const snapshot=desktop.control.snapshot.bind(desktop.control);
  desktop.control.snapshot=()=>({...snapshot(),addresses:[{name:'Isolated loopback test',address:new URL(r.url).hostname}]});
  try{await require('./photo-app-browser-check.cjs')({r,paired,group,url,root,api,desktopUrl:desktop.url});}
  finally{await new Promise(resolve=>desktop.server.close(resolve));await stop();}return;
 }
 if(process.argv.includes('--check-ui')){
  const {chromium}=require(path.join(root,'.test/photo-ui/node_modules/playwright')),browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true}),context=await browser.newContext({viewport:{width:1600,height:1050}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));let passed=false;
  try{
   await page.goto(url);await page.waitForSelector('#connection');await page.screenshot({path:path.join(root,'.test/photo-tools/preview-empty.png'),fullPage:true});
   const sharp=require('sharp'),input=await sharp({create:{width:72,height:16,channels:3,background:{r:127,g:74,b:31}}}).png().toBuffer();
   await page.locator('#files').setInputFiles({name:'local-check.png',mimeType:'image/png',buffer:input});await page.click('#run');
   const judge=await context.newPage();await judge.goto(url+'&view=judge');await judge.waitForFunction(()=>document.querySelectorAll('.node').length>0,{},{timeout:60000});await judge.screenshot({path:path.join(root,'.test/photo-tools/preview-running.png'),fullPage:true});
   await page.waitForFunction(()=>!document.querySelector('#run').disabled,{},{timeout:240000});const state=await page.locator('#state').innerText(),error=await page.locator('#error').innerText();if(state!=='全部结果已交付')throw Error('PHOTO_UI_FAILED: '+state+' '+error);
   await judge.waitForFunction(()=>document.querySelector('#preview img'),{},{timeout:15000});await judge.screenshot({path:path.join(root,'.test/photo-tools/preview-result.png'),fullPage:true});
   await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(root,'.test/photo-tools/preview-mobile.png'),fullPage:true});
   const runs=await api('/'+group+'/photo-runs'),evidence=await api('/'+group+'/photo-runs/'+runs[0].id);
   const attempts=await r.db.attempt.findMany({where:{workflowId:{in:evidence.jobs.map(j=>j.id)}}});
   const stages=evidence.workflows.reduce((sum,w)=>sum+w.nodes.length,0);
   if(!evidence.allCommitted||attempts.length!==stages||new Set(attempts.map(a=>a.workflowId+':'+a.nodeId)).size!==stages)throw Error('PHOTO_EXECUTION_EVIDENCE_INVALID');
   fs.writeFileSync(path.join(root,'.test/photo-tools/ui-evidence.json'),JSON.stringify({kind:'LOCAL_PROCESS_TEST',...evidence},null,2));
   if(errors.length)throw Error(errors.join(';'));passed=true;console.log('PHOTO_UI_PASSED');
  }catch(e){console.log('UI_ERROR',await page.locator('#error').innerText(),await page.locator('#state').innerText());await page.screenshot({path:path.join(root,'.test/photo-tools/preview-failure.png'),fullPage:true});throw e;}finally{await browser.close();if(passed&&process.argv.includes('--keep-open'))console.log('REHEARSAL_LEFT_RUNNING',url);else await stop();}
 }
}
main().catch(e=>{console.error(e);process.exit(1);});
