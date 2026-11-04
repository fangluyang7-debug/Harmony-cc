// Run on a dedicated loopback emulator with a fresh agent installation.
const path=require('node:path'),fs=require('node:fs/promises'),assert=require('node:assert/strict');
const {promisify}=require('node:util'),exec=promisify(require('node:child_process').execFile);
const {randomUUID}=require('node:crypto');
const {runtime}=require('../../services/coordinator/test/helpers.cjs');
const {appRequest}=require('@harmony/scheduler-client/dist/node');
const root=path.resolve(__dirname,'../..'),target=process.env.HDC_TARGET,hdc=process.env.HDC_PATH;
if(!hdc||!/^127\.0\.0\.1:\d+$/.test(target??'')||!process.env.HARMONY_AGENT_HAP)throw Error('DEDICATED_EMULATOR_REQUIRED');
process.chdir(path.join(root,'services/coordinator'));
const bundle='org.harmonycc.agent',layout='/data/local/tmp/harmony-display-test.json';
async function call(...args){try{return (await exec(hdc,['-t',target,...args],{windowsHide:true,timeout:30000,maxBuffer:4194304})).stdout;}catch{throw Error('EMULATOR_COMMAND_FAILED');}}
async function element(label,click=false){
 const end=Date.now()+30000;
 while(Date.now()<end){
  await call('shell','uitest','dumpLayout','-b',bundle,'-p',layout);
  const raw=await call('shell','cat',layout);let tree;
  try{tree=JSON.parse(raw);}catch{await new Promise(r=>setTimeout(r,300));continue;}
  const queue=Array.isArray(tree)?[...tree]:[tree];
  while(queue.length){
   const item=queue.pop();if(!item||typeof item!=='object')continue;
   const a=item.attributes;
   if(a?.text===label){
    if(click){const n=a.bounds.match(/-?\d+/g).map(Number);await call('shell','uitest','uiInput','click',String(Math.floor((n[0]+n[2])/2)),String(Math.floor((n[1]+n[3])/2)));}
    return;
   }
   queue.push(...(item.children??[]));
  }
  await new Promise(r=>setTimeout(r,250));
 }
 throw Error('VISIBLE_ELEMENT_NOT_FOUND '+label);
}
async function main(){
 const r=await runtime({cpuHost:true},{COORDINATOR_CERTIFICATE_HOST:'127.0.0.1'}),port='tcp:'+new URL(r.url).port;
 try{
  const group=randomUUID(),holder=randomUUID(),device=randomUUID(),invite=await r.auth.invite(group,'screen-owner',device,r.url);
  await r.allotments.confirmDevice(device,[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:268435456}],[{groupId:group,holderInstanceId:holder,appInstanceId:null}]);
  const bootstrap={invitation:invite,holderInstanceId:holder,domain:'SIMULATED',contribution:{ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0}};
  const origin=await r.auth.invite(group,'origin-owner','origin',r.url),paired=await r.auth.exchange({inviteId:origin.inviteId,code:origin.code,holderInstanceId:'origin-holder'});
  const req=appRequest({...origin,credential:paired.credential}),send=async(route,body)=>JSON.parse(await req('/v2/display'+route,body?JSON.stringify(body):null));
  await call('rport',port,port);
  assert.match(await call('install',process.env.HARMONY_AGENT_HAP),/install bundle successfully/i);
  await call('shell','aa','force-stop',bundle);
  const started=await call('shell','aa','start','-a','EntryAbility','-b',bundle,'--ps','bootstrap',Buffer.from(JSON.stringify(bootstrap)).toString('base64'));
  if(!started.includes('start ability successfully'))throw Error('DISPLAY_ABILITY_START_FAILED');
  await element('结果展示',true);
  const id='/'+(await send('',{viewerHolderId:holder,leaseMs:180000})).id;
  await element('接收来自 origin-holder 的结果',true);
  await element('等待来源设备发布结果');
  await send(id+'/publish',{version:1,text:'Display fixture version one'});await element('Display fixture version one');
  await send(id+'/publish',{version:2,text:'Display fixture version two'});await element('Display fixture version two');
  await assert.rejects(send(id+'/publish',{version:1,text:'stale'}),/DISPLAY_VERSION_CONFLICT/);
  assert.equal((await send(id)).shownVersion,0);
  await element('确认已看到此版本',true);
  for(const end=Date.now()+5000;(await send(id)).shownVersion!==2;){if(Date.now()>end)throw Error('DISPLAY_ACK_TIMEOUT');await new Promise(r=>setTimeout(r,100));}
  await send(id+'/revoke',{});await element('等待同组设备邀请');
  const next='/'+(await send('',{viewerHolderId:holder,leaseMs:180000})).id;
  await element('接收来自 origin-holder 的结果',true);await element('退出展示',true);await element('等待同组设备邀请');
  assert.equal((await send(next)).state,'LEFT');
  const report={domain:'SIMULATED',api:(await call('shell','param','get','const.ohos.apiversion')).trim(),
   hapSha256:require('node:crypto').createHash('sha256').update(await fs.readFile(process.env.HARMONY_AGENT_HAP)).digest('hex'),
   checks:['visible versions 1 and 2','stale publish refused','human-action acknowledgement','revocation clears view','viewer exit closes lease']};
  await fs.writeFile(path.join(r.config.dataDir,'display-emulator.json'),JSON.stringify(report,null,2));
  console.log('PASS',JSON.stringify(report),path.relative(root,r.config.dataDir));
 }finally{await call('shell','aa','force-stop',bundle).catch(()=>{});await call('rport','rm',port,port).catch(()=>{});await r.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
