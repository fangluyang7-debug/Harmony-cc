// Independent ArkTS App -> registered credential -> SDK -> PlanningService -> PC -> native result.
// Only a loopback emulator is accepted. No physical-device acceptance is performed.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{execFile}=require('node:child_process');
const root=path.resolve(__dirname,'../..');process.chdir(path.join(root,'services/coordinator'));
const {runtime}=require('../../services/coordinator/test/helpers.cjs'),{start}=require('../agent-conformance/drivers.cjs');
const hdc=process.env.HDC_PATH||'D:/Users/17321/AppData/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe',target=process.env.HDC_TARGET||'127.0.0.1:5555';
if(!/^127\.0\.0\.1:\d+$/.test(target))throw Error('EMULATOR_REQUIRED');
const call=(...args)=>new Promise((resolve,reject)=>execFile(hdc,['-t',target,...args],{windowsHide:true,timeout:30000,maxBuffer:4194304},(e,out)=>e?reject(Error('EMULATOR_COMMAND_FAILED')):resolve(out)));
async function until(check){const end=Date.now()+90000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,250));}throw Error('NATIVE_SDK_TIMEOUT');}
async function main(){
 const r=await runtime({cpuHost:true},{COORDINATOR_CERTIFICATE_HOST:'127.0.0.1'}),dir=r.config.dataDir,port=new URL(r.url).port,report={domain:'SIMULATED',path:'HDC_LOOPBACK',status:'RUNNING',checks:[],errors:[]};let worker;
 try{
  const group=randomUUID(),device=randomUUID(),holder=randomUUID(),settings={ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0};
  const invitation=await r.auth.invite(group,randomUUID(),device,r.url),bootstrap=path.join(dir,'worker.json');
  await r.allotments.confirmDevice(device,[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:268435456}],[{groupId:group,holderInstanceId:holder,appInstanceId:null}]);
  fs.writeFileSync(bootstrap,JSON.stringify({invitation,holderInstanceId:holder,domain:'SIMULATED'}));worker=await start('pc',{root,dir,bootstrap,settings});
  await until(async()=>{try{return (await r.snapshots.build(group)).snapshot.candidates.length===2;}catch{return false;}});
  const ownerInvite=await r.auth.invite(group,randomUUID(),randomUUID(),r.url),owner=await r.auth.exchange({inviteId:ownerInvite.inviteId,code:ownerInvite.code,holderInstanceId:randomUUID()});
  const appInvite=await r.apps.register(owner.peer,{label:'Native SDK probe',allowedContracts:['text.count.v1','vector.normalize.v1'],maxConcurrent:1,resources:[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:67108864}],offlineBase:[],onlineExtra:[]},r.url);
  await call('rport','tcp:'+port,'tcp:'+port);
  const hap=path.join(root,'.test/s2-harmony-har-probe/entry/build/default/outputs/default/entry-default-unsigned.hap');
  await call('shell','aa','force-stop','org.harmonycc.harprobe').catch(()=>{});
  assert.match(await call('install',hap),/install bundle successfully/);
  // No invitation/credential is logged or written to a repository file.
  await call('shell','aa','start','-a','EntryAbility','-b','org.harmonycc.harprobe','--ps','sdkInvitation',Buffer.from(JSON.stringify(appInvite)).toString('base64'));
  await until(async()=>{const jobs=await r.db.cpuJob.findMany({where:{groupId:group}});if(jobs.length!==2)return false;return (await r.db.receipt.findMany({where:{id:{in:jobs.map(j=>j.id)}}})).filter(row=>row.committed).length===2;});
  let logs='';await until(async()=>{logs=await call('shell','hilog','-x','-T','HarmonyProbe');return logs.includes('text/vector outputs verified; run='+appInvite.registrationId);});fs.writeFileSync(path.join(dir,'native.log'),logs);
  const jobs=await r.db.cpuJob.findMany({where:{groupId:group}});
  for(const job of jobs){const data=JSON.parse(job.metadataJson),receipt=JSON.parse((await r.db.receipt.findUnique({where:{id:job.id}})).recordJson);assert.equal(data.offer.task.app.appInstanceId,appInvite.appInstanceId);assert.equal(receipt.state,'SUCCEEDED');assert.equal(receipt.resourcesSettled,true);assert.ok(data.plan.snapshotVersion>0);report.checks.push({capability:data.offer.task.contract.capability,state:receipt.state,committed:true,appBound:true,snapshotVersion:data.plan.snapshotVersion});}
  report.status='PASS';console.log('PASS native ArkTS SDK: independently registered App, text/vector, 2 committed receipts');
 }catch(error){report.status='FAIL';report.errors.push(error.message);throw error;}
 finally{fs.writeFileSync(path.join(dir,'sdk-report.json'),JSON.stringify(report,null,2));await call('shell','aa','force-stop','org.harmonycc.harprobe').catch(()=>{});await call('rport','rm','tcp:'+port,'tcp:'+port).catch(()=>{});await worker?.stop();await r.close();console.log('Evidence: '+path.relative(root,path.join(dir,'sdk-report.json')));}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
