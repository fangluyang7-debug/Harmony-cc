// Agent-independent assertions. Only the launch adapter knows its implementation.
// The coordinator is a protocol test fixture; no agent memory/ledger is read for assertions.
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {fork,execFileSync}=require('node:child_process');
const {createCoordinator}=require('../../services/coordinator/dist/app');
const {loadConfig}=require('../../services/coordinator/dist/config');
const core=require('@harmony/scheduler-core');
const {WebSocket}=require('ws');
const root=path.resolve(__dirname,'../..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const kind=process.argv[process.argv.indexOf('--agent')+1];
const includeCrop=process.argv.includes('--include-crop');
const domain=kind==='harmony-device'?'REAL':'SIMULATED',host=process.env.CONFORMANCE_HOST||'127.0.0.1';
if(!['pc','harmony-emulator','harmony-device'].includes(kind))throw Error('Use --agent pc|harmony-emulator|harmony-device');
async function until(check,ms=kind==='harmony-device'?180000:45000){const end=Date.now()+ms;while(Date.now()<end){const value=await check();if(value)return value;await sleep(100);}throw Error('CONFORMANCE_TIMEOUT');}
function api(address,cert){let cookie='';return async(route,body,headers={})=>new Promise((resolve,reject)=>{
 const bytes=body===undefined?null:Buffer.from(JSON.stringify(body));const req=https.request(new URL(route,address),{ca:cert,method:bytes?'POST':'GET',headers:{Cookie:cookie,...headers,...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{})}},res=>{const chunks=[];if(res.headers['set-cookie'])cookie=res.headers['set-cookie'][0].split(';')[0];res.on('data',b=>chunks.push(b));res.on('end',()=>{try{const data=JSON.parse(Buffer.concat(chunks));if(res.statusCode<200||res.statusCode>=300)throw Error(data.message||data.error||'HTTP_'+res.statusCode);resolve(data);}catch(e){reject(e);}});});req.setTimeout(15000,()=>req.destroy(Error('HTTP_TIMEOUT')));req.on('error',reject);req.end(bytes);
});}
async function main(){
 const dir=fs.mkdtempSync(path.join(root,'.test/agent-conformance-'));
 const report={agent:kind,domain,startedAt:new Date().toISOString(),checks:[],wireCounts:{},errors:[]};
 const save=()=>fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));
 const config=loadConfig({COORDINATOR_DATA_DIR:path.join(dir,'coordinator'),COORDINATOR_HOST:host,COORDINATOR_PORT:'0',COORDINATOR_CERTIFICATE_HOST:host,COORDINATOR_DOMAIN:domain});
 execFileSync(process.execPath,['scripts/migrate.cjs'],{cwd:path.join(root,'services/coordinator'),env:{...process.env,COORDINATOR_DATA_DIR:config.dataDir},stdio:'pipe',windowsHide:true});
 const r=await createCoordinator(config,async()=>{},{cpuHost:true});let driver,releaseInput=()=>{},blockInput=false,blocked=0;
 const messages=[],sent=[],sessions=new Set(),artifactWrites=[],receive=r.channel.receive.bind(r.channel),send=r.channel.send.bind(r.channel),handle=r.artifacts.handle.bind(r.artifacts);
 r.channel.receive=async(s,text)=>{const m=JSON.parse(text);messages.push(m);report.wireCounts[m.type]=(report.wireCounts[m.type]||0)+1;return receive(s,text);};
 r.channel.send=async(s,m)=>{sessions.add(s);sent.push(m);return send(s,m);};
 let inputGate=Promise.resolve();
 r.artifacts.handle=async(req,res)=>{if(req.method==='PUT')artifactWrites.push(req.url);if(blockInput&&req.method==='GET'&&req.url.includes('/in-')){blocked++;await inputGate;}return handle(req,res);};
 const step=async(name,run)=>{const item={name,status:'RUNNING'};report.checks.push(item);const t=performance.now();try{await run(item);item.status='PASS';}catch(e){item.status='FAIL';item.error=e.message;console.log('FAIL '+name+': '+e.message);}item.durationMs=performance.now()-t;save();};
 try{
  await r.app.listen(0,host);await r.restore();config.publicUrl='https://'+host+':'+r.app.getHttpServer().address().port;
  const request=api(config.publicUrl,r.identity.cert),spaces=(route,body)=>request('/v2/spaces'+route,body);
  await spaces('/register',{account:'conformance-'+crypto.randomUUID(),password:crypto.randomBytes(24).toString('hex'),name:'代理一致性测试'});
  const group=(await spaces('/',{name:'独立协议一致性测试'})).id,settings={ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0};
  const submit=async body=>{const deadline=Date.now()+15000;for(;;){try{return await spaces('/'+group+'/jobs',body);}catch(e){if(!['NO_LEGAL_PLAN','ALLOTMENT_UNAVAILABLE','PLAN_STALE'].includes(e.message)||Date.now()>=deadline)throw e;await sleep(100);}}};
  const device=await spaces('/'+group+'/devices',{name:kind,settings});
  const deviceId=(await spaces('/'+group)).devices[0].id;
  const bootstrap=path.join(dir,'invitation.json');fs.writeFileSync(bootstrap,JSON.stringify(device),{mode:0o600});
  const adapter=require('./drivers.cjs');driver=await adapter.start(kind,{root,dir,bootstrap,address:config.publicUrl,settings});
  let profile,sourceOffer,jobId,fixturePeer;
  await step('01 pairing, credential binding and one-use invitation',async()=>{
   profile=await until(async()=>{const d=await spaces('/'+group);return d.devices[0]?.online&&d.devices[0].profile;});
   assert.equal(profile.holderInstanceId,device.holderInstanceId);assert.equal(profile.deviceId,deviceId);
   await assert.rejects(request('/v2/pair',{inviteId:device.invitation.inviteId,code:device.invitation.code,holderInstanceId:device.holderInstanceId}));
  });
  await step('02 profile schema, unknown values and monotonic sequence',async()=>{
   assert.ok(core.validDeviceProfileV2(profile));assert.equal(profile.domain,domain);assert.equal(profile.battery.value,null);assert.equal(profile.temperature.value,null);
   await until(()=>messages.filter(m=>m.type==='DeviceProfile').length>=2);
   const rows=messages.filter(m=>m.type==='DeviceProfile').map(m=>JSON.parse(m.payload));assert.ok(rows.every(core.validDeviceProfileV2));
   assert.ok(rows[rows.length-1].sequence>rows[0].sequence);
  });
  await step('03 qualified dispatch, atomic admission, execution and artifact result via PlanningService',async()=>{
   await until(async()=>{const d=await spaces('/'+group);return d.devices[0].capabilities.some(c=>c.capability==='text.count.v1'&&c.available&&c.state==='ACTIVE');});
   jobId=crypto.randomUUID();await submit({requestId:jobId,capability:'text.count.v1',input:{text:'Hello conformance'}});
   const result=await until(async()=>{const result=await spaces('/'+group+'/jobs/'+jobId);if(['FAILED','REJECTED'].includes(result.state))throw Error(result.state+':'+JSON.stringify(result.rejection));return result.output&&result;});
   assert.deepEqual(result.output,{characters:17,words:2,lines:1});assert.ok(result.decisionEvidence.snapshotVersion>0);
   sourceOffer=sent.find(m=>m.type==='DispatchOffer'&&JSON.parse(m.payload).task.attemptId===jobId);assert.ok(sourceOffer);
   assert.ok(messages.some(m=>m.type==='AdmissionReply'&&JSON.parse(m.payload).attemptId===jobId));
   const trace=await until(async()=>{const trace=await spaces('/'+group+'/jobs/'+jobId+'/trace');return ['PLAN','OFFER','ADMIT','QUEUE','LOAD','EXECUTE','PUBLISH'].every(phase=>trace.spans.some(s=>s.phase===phase))&&trace;});
   assert.ok(trace.spans.every(s=>s.snapshotVersion===result.decisionEvidence.snapshotVersion));
  });
  if(includeCrop)await step('03b ImageKit crop dispatched by PlanningService; geometry/colour checked; malformed crop settles as failed',async()=>{
   const {builtinReferencePacks}=require('@harmony/reference-capabilities'),{transfer}=require('@harmony/resource-transport');
   const pack=(await builtinReferencePacks()).find(p=>p.manifest.contract.capability==='image.crop.v1');
   await until(async()=>{const d=await spaces('/'+group);return d.devices[0].capabilities.some(c=>c.capability==='image.crop.v1'&&c.available&&c.state==='ACTIVE');});
   const owner=(await r.auth.activePeers()).find(p=>p.holderInstanceId===device.holderInstanceId),invite=await r.auth.invite(group,owner.principalId,crypto.randomUUID(),config.publicUrl);
   const source=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:crypto.randomUUID()}),headers={Authorization:'Bearer '+source.credential};
   const endpoint={address:config.publicUrl,certificate:invite.certificate,fingerprint:invite.fingerprint,domain};
   for(const [index,test]of [...pack.cases, {...pack.cases[0],parameters:'{"box":{"x":-1,"y":0,"width":1,"height":1},"paddingRatio":0,"targetSize":32,"jpegQuality":90}'}].entries()){
    const id=crypto.randomUUID(),metadata={requestId:id,capability:pack.manifest.contract.capability,contentHash:crypto.createHash('sha256').update(test.input).digest('hex'),bytes:test.input.length,parameters:test.parameters};
    let plan;await until(async()=>{try{plan=await request('/v2/jobs',metadata,headers);return true;}catch(e){if(!['NO_LEGAL_PLAN','ALLOTMENT_UNAVAILABLE','PLAN_STALE'].includes(e.message))throw e;return false;}});
    await transfer(endpoint,plan.inputTicket,source.credential,test.input);
    await until(async()=>{try{await request('/v2/jobs/'+id+'/start',{},headers);return true;}catch(e){if(!['NO_LEGAL_PLAN','ALLOTMENT_UNAVAILABLE','PLAN_STALE'].includes(e.message))throw e;return false;}});
    let result;await until(async()=>{result=await request('/v2/jobs/'+id,undefined,headers);return ['SUCCEEDED','FAILED','REJECTED','CANCELLED_SETTLED'].includes(result.state);});
    if(index<pack.cases.length){assert.equal(result.state,'SUCCEEDED',JSON.stringify(result.rejection));const output=(await transfer(endpoint,result.outputTicket,source.credential)).bytes;assert.ok(await pack.evaluate(test,output)>=pack.manifest.qualityThreshold);assert.ok(result.decisionEvidence.snapshotVersion>0);}
    else{assert.equal(result.state,'FAILED');assert.equal(result.outputTicket,null);const receipt=messages.find(m=>m.type==='ExecutionReceipt'&&JSON.parse(m.payload).receipt.attemptId===id);assert.equal(JSON.parse(receipt.payload).receipt.errorCode,'CROP_INVALID');assert.equal(JSON.parse(receipt.payload).receipt.resourcesSettled,true);}
   }
  });
  if(includeCrop&&kind==='harmony-emulator')await step('03c emulator lifecycle: background stops admission, foreground resumes qualified contribution',async()=>{
   await driver.background();
   await until(async()=>{const d=await spaces('/'+group);return d.devices[0].profile.foreground.value==='BACKGROUND'&&d.devices[0].profile.ownerActivity.value==='ACTIVE'&&!d.devices[0].capabilities.some(c=>c.available);});
   await assert.rejects(spaces('/'+group+'/jobs',{requestId:crypto.randomUUID(),capability:'text.count.v1',input:{text:'background blocked'}}),/NO_LEGAL_PLAN/);
   await driver.foreground();await until(async()=>{const d=await spaces('/'+group);return d.devices[0].profile.foreground.value==='FOREGROUND'&&d.devices[0].capabilities.some(c=>c.capability==='text.count.v1'&&c.available&&c.state==='ACTIVE');});
  });
  async function inject(offer){const sequence=await r.db.dispatchSequence.update({where:{id:r.identity.id},data:{value:{increment:1}}});const m={...sourceOffer,messageId:crypto.randomUUID(),seq:sequence.value,payload:JSON.stringify(offer)};
   await r.db.outbox.create({data:{id:m.messageId,sequence:m.seq,groupId:group,attemptId:jobId,kind:'DispatchOffer',epoch:r.epoch,messageJson:JSON.stringify(m)}});await r.channel.flush();return m;}
  await step('04 same attempt with a new messageId returns existing admission/result without executing twice',async()=>{
   const receipts=messages.filter(m=>m.type==='ExecutionReceipt'&&JSON.parse(m.payload).receipt.attemptId===jobId).length;
   const writes=artifactWrites.filter(url=>url.includes('/out-'+jobId+'/')).length;assert.equal(writes,1);
   const duplicate=await inject(JSON.parse(sourceOffer.payload));
   await until(()=>messages.some(m=>m.type==='Ack'&&m.ackOf===duplicate.messageId));
   await until(()=>messages.filter(m=>m.type==='ExecutionReceipt'&&JSON.parse(m.payload).receipt.attemptId===jobId).length>receipts);
   assert.equal(await r.db.attempt.count({where:{id:jobId}}),1);
   assert.equal(artifactWrites.filter(url=>url.includes('/out-'+jobId+'/')).length,writes,'duplicate must not publish another engine result');
  });
  await step('05 changed attempt input is ATTEMPT_CONFLICT; foreign fence cannot commit',async()=>{
   const bad=JSON.parse(sourceOffer.payload);bad.task.parameters='{"conflict":true}';const duplicate=await inject(bad);
   await until(()=>messages.some(m=>m.type==='ProtocolError'&&JSON.parse(m.payload).messageId===duplicate.messageId&&JSON.parse(m.payload).code==='ATTEMPT_CONFLICT'));
   await r.db.outbox.update({where:{id:duplicate.messageId},data:{superseded:true}});
   const receipt=messages.filter(m=>m.type==='ExecutionReceipt'&&JSON.parse(m.payload).receipt.attemptId===jobId).at(-1),payload=JSON.parse(receipt.payload);payload.receipt.fence.counter++;
   // An isolated authenticated protocol peer avoids corrupting the tested agent's stream cursor.
   const owner=(await r.auth.activePeers()).find(p=>p.holderInstanceId===device.holderInstanceId),invite=await r.auth.invite(group,owner.principalId,deviceId,config.publicUrl);
   fixturePeer=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:crypto.randomUUID()});
   await new Promise((resolve,reject)=>{
    const ws=new WebSocket(config.publicUrl.replace('https:','wss:')+'/v2/channel',{ca:r.identity.cert,headers:{Authorization:'Bearer '+fixturePeer.credential}}),helloId=crypto.randomUUID();
    const timer=setTimeout(()=>{ws.terminate();reject(Error('FOREIGN_FENCE_TIMEOUT'));},10000);
    const envelope={...receipt,groupId:group,senderInstanceId:fixturePeer.peer.holderInstanceId,coordinatorEpoch:r.epoch,extensions:[],ackOf:null};
    ws.on('error',reject);ws.on('open',()=>ws.send(JSON.stringify({...envelope,messageId:helloId,seq:1,type:'Hello',payload:JSON.stringify({versions:[2],extensions:[]})})));
    ws.on('message',data=>{const m=JSON.parse(data);if(m.ackOf===helloId)ws.send(JSON.stringify({...envelope,messageId:crypto.randomUUID(),seq:2,payload:JSON.stringify(payload)}));});
    ws.on('close',(code,reason)=>{clearTimeout(timer);try{assert.equal(code,1008);assert.match(reason.toString(),/RECEIPT_UNAUTHORIZED/);resolve();}catch(e){reject(e);}});
   });
  });
  await step('06 owner activity sends YieldNotice, stops admission, and cancellation retains resources until settlement',async(check)=>{
   blockInput=true;inputGate=new Promise(resolve=>{releaseInput=resolve;});blocked=0;
   const id=crypto.randomUUID();await submit({requestId:id,capability:'text.count.v1',input:{text:'held input'}});
   await until(async()=>{if(blocked>0)return true;const s=await spaces('/'+group+'/jobs/'+id);if(s.state==='REJECTED')throw Error(JSON.stringify(s.rejection));return false;});check.stage='input-held';
   await spaces('/'+group+'/devices/'+deviceId,{settings:{...settings,ownerMode:'paused'}});
   await until(()=>messages.some(m=>m.type==='YieldNotice'&&JSON.parse(m.payload).attemptId===id));check.stage='yield-received';
   await until(async()=>{const d=await spaces('/'+group);return d.devices[0].profile.ownerActivity.value==='ACTIVE'&&!d.devices[0].capabilities.some(c=>c.available);});
   const before=await spaces('/'+group+'/jobs/'+id);assert.equal(before.output,null);
   assert.ok(!messages.some(m=>m.type==='ExecutionReceipt'&&JSON.parse(m.payload).receipt.attemptId===id),'no premature settlement while HTTP input remains held');
   await assert.rejects(spaces('/'+group+'/jobs',{requestId:crypto.randomUUID(),capability:'text.count.v1',input:{text:'blocked'}}),/NO_LEGAL_PLAN/);
   blockInput=false;releaseInput();await until(()=>messages.some(m=>m.type==='ExecutionReceipt'&&JSON.parse(m.payload).receipt.attemptId===id&&JSON.parse(m.payload).receipt.resourcesSettled));
   await spaces('/'+group+'/devices/'+deviceId,{settings});
  });
  await step('07 reconnect recovery queries existing attempts; grant renewal never increases physical capacity',async(check)=>{
   await until(async()=>{const d=await spaces('/'+group);return d.devices[0].capabilities.some(c=>c.capability==='text.count.v1'&&c.available&&c.state==='ACTIVE');});
   const validIssue=r.allotments.issue.bind(r.allotments);let tamperedVersion=0;
   r.allotments.issue=async(peer,input)=>{const grant=await validIssue(peer,input);if(peer.holderInstanceId!==device.holderInstanceId)return grant;tamperedVersion=grant.version;return {...grant,signature:(grant.signature[0]==='A'?'B':'A')+grant.signature.slice(1)};};
   try{await until(()=>tamperedVersion>0,7000);await sleep(2200);const reservation=(await r.allotments.reservations(deviceId)).find(x=>x.grant.holderInstanceId===device.holderInstanceId);assert.ok((reservation.ack?.version??0)<tamperedVersion,'a grant with a forged signature must never receive a persisted ACK');check.forgedSignatureRejected=true;}finally{r.allotments.issue=validIssue;}
   await until(async()=>{const reservation=(await r.allotments.reservations(deviceId)).find(x=>x.grant.holderInstanceId===device.holderInstanceId);return reservation.ack?.version===reservation.grant.version;},7000);
   blockInput=true;inputGate=new Promise(resolve=>{releaseInput=resolve;});blocked=0;
   const id=crypto.randomUUID();await submit({requestId:id,capability:'text.count.v1',input:{text:'recovery'}});await until(()=>blocked>0);
   const hello=messages.filter(m=>m.type==='Hello').length;for(const s of sessions)if(s.socket.readyState===1)s.socket.close(1001,'CONFORMANCE_RECONNECT');
   await until(()=>messages.filter(m=>m.type==='Hello').length>hello);await until(()=>messages.some(m=>m.type==='AttemptStatusReply'&&JSON.parse(m.payload).attemptId===id));
   const capacity=[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:268435456}];
   assert.ok(fixturePeer,'foreign protocol fixture is required');
   await r.allotments.confirmDevice(deviceId,capacity,[{groupId:group,holderInstanceId:device.holderInstanceId,appInstanceId:null},{groupId:group,holderInstanceId:fixturePeer.peer.holderInstanceId,appInstanceId:null}]);
   const issue=r.allotments.issue.bind(r.allotments);r.allotments.issue=(peer,input)=>issue(peer,peer.holderInstanceId===device.holderInstanceId?{...input,extra:[]}:input);
   await until(async()=>{const a=(await r.allotments.reservations(deviceId)).find(x=>x.grant.holderInstanceId===device.holderInstanceId);return a.grant.extra.length===0&&a.ack?.version===a.grant.version;},7000);
   const quota={ledgerEpoch:1,leaseRequestId:crypto.randomUUID(),leaseMs:60000,base:[],extra:capacity},headers={Authorization:'Bearer '+fixturePeer.credential};
   await request('/v2/allotments/request',{...quota,leaseRequestId:crypto.randomUUID(),extra:[]},headers);await assert.rejects(request('/v2/allotments/request',quota,headers),/ALLOTMENT_REJECTED/);
   blockInput=false;releaseInput();await until(()=>messages.some(m=>m.type==='ExecutionReceipt'&&JSON.parse(m.payload).receipt.attemptId===id&&JSON.parse(m.payload).receipt.resourcesSettled));
   let grant;await until(async()=>{try{grant=await request('/v2/allotments/request',quota,headers);return true;}catch(e){if(!e.message.includes('ALLOTMENT_REJECTED'))throw e;return false;}},10000);
   fs.writeFileSync(path.join(dir,'fixture-holder-grant.json'),JSON.stringify(grant));
   const reduced=await request('/v2/allotments/request',{...quota,leaseRequestId:crypto.randomUUID(),extra:[]},headers);
   const ack={allotmentId:reduced.allotmentId,holderInstanceId:reduced.holderInstanceId,ledgerEpoch:reduced.ledgerEpoch,coordinatorEpoch:reduced.coordinatorEpoch,version:reduced.version,persisted:true,settlementSeq:0,occupied:[]};
   fs.writeFileSync(path.join(dir,'fixture-holder-grant.json'),JSON.stringify(reduced));
   await request('/v2/allotments/ack',{ack,signature:crypto.createHmac('sha256',crypto.createHash('sha256').update(fixturePeer.credential).digest()).update(core.canonical(ack)).digest('base64')},headers);
   r.allotments.issue=issue;const grants=await r.allotments.reservations(deviceId);
   const total=core.vectorSumV2(...grants.map(x=>x.reserved));assert.ok(total.every(v=>v.amount<=(v.resourcePoolId==='cpu'?1:268435456)));
  });
  await step('08 revoked credential cannot reconnect or publish new telemetry',async()=>{
   const peer=(await r.auth.activePeers()).find(p=>p.holderInstanceId===device.holderInstanceId);assert.ok(peer);await r.auth.revoke(peer.credentialId);
   await until(()=>[...sessions].every(s=>s.socket.readyState!==1));await sleep(1200);
   assert.equal((await r.auth.activePeers()).some(p=>p.holderInstanceId===device.holderInstanceId),false);
  });
 }catch(e){report.errors.push(e.message);throw e;}finally{blockInput=false;releaseInput();await driver?.stop();await r.close();report.finishedAt=new Date().toISOString();save();console.log('Report '+path.join(dir,'report.json'));}
 const failed=report.checks.filter(c=>c.status!=='PASS');console.log(report.checks.filter(c=>c.status==='PASS').length+'/'+report.checks.length+' passed');if(failed.length||report.checks.length!==(8+(includeCrop?1:0)+(includeCrop&&kind==='harmony-emulator'?1:0)))process.exitCode=1;
}
main().catch(e=>{console.error('Conformance failed: '+e.message);process.exitCode=1;});
