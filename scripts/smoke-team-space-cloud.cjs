// Creates a private, clearly named software-test space. No native phone/GPU acceptance.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFile,fork}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const command=(file,args)=>new Promise((resolve,reject)=>execFile(process.execPath,[file,...args],{windowsHide:true,timeout:60000},(e,stdout,stderr)=>e?reject(Error(stderr||e.message)):resolve(stdout)));
async function main(){
 const address=process.argv[2];if(!address||new URL(address).protocol!=='https:')throw Error('Provide the intended Harmony HTTPS service URL');
 const dir=fs.mkdtempSync(path.join(root,'.test/cloud-space-'));let cookie='',host,connection,spaceId;const errors=[];
 const api=async(route,body)=>{const response=await fetch(address+'/v2/spaces'+route,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const data=await response.json();if(!response.ok)throw Error(data.error??'CLOUD_REQUEST_FAILED');return data;};
 const until=async(check)=>{const deadline=Date.now()+120000;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,1000));}throw Error('CLOUD_CHECK_TIMEOUT');};
 try{
  const account='software-check-'+crypto.randomUUID(),password=crypto.randomBytes(24).toString('base64url');
  await api('/register',{account,password,name:'软件链路验证'});
  fs.writeFileSync(path.join(dir,'test-account.json'),JSON.stringify({address,account,password}),{mode:0o600});
  spaceId=(await api('/',{name:'软件链路验证 · '+new Date().toISOString()})).id;
  console.log('Private software-test space created.');
  const settings={ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:134217728};
  const device=await api('/'+spaceId+'/devices',{name:'临时 CPU 软件验证代理',settings});assert.equal(device.invitation.tlsMode,'public');
  const invitation=path.join(dir,'invitation.json'),policy=path.join(dir,'contribution.json'),installation=path.join(dir,'host');
  fs.writeFileSync(invitation,JSON.stringify(device),{mode:0o600});fs.writeFileSync(policy,JSON.stringify(settings),{mode:0o600});
  await command(path.join(root,'services/pc-agent/dist/pairing-main.js'),[invitation,installation]);
  console.log('Public TLS pairing passed. Waiting for capabilities.');
  connection=JSON.parse(fs.readFileSync(path.join(installation,'agent.json'))).connection;
  host=fork(path.join(root,'services/pc-agent/dist/host-main.js'),[path.join(installation,'agent.json'),policy],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
  host.stderr.on('data',b=>{if(errors.length<12){const message=b.toString().trim();errors.push(message);console.log('Agent diagnostic: '+message);}});
  await until(async()=>{const d=await api('/'+spaceId);return d.devices[0].capabilities.length===2&&d.devices[0].capabilities.every(c=>c.available&&c.state==='ACTIVE');});
  console.log('Automatic qualification passed. Submitting real CPU work.');
  const id=crypto.randomUUID();await api('/'+spaceId+'/jobs',{requestId:id,capability:'text.count.v1',input:{text:'Hello cloud'}});
  let result;await until(async()=>{result=await api('/'+spaceId+'/jobs/'+id);return !!result.output;});assert.deepEqual(result.output,{characters:11,words:2,lines:1});
  const current=await api('/'+spaceId);assert.equal(current.coordinator.location,'CLOUD');
  await api('/'+spaceId+'/devices/'+current.devices[0].id,{settings:{...settings,ownerMode:'paused'}});
  await until(async()=>{const d=await api('/'+spaceId);return d.devices[0].profile.ownerActivity.value==='ACTIVE';});
  fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({address,spaceId,jobId:id,state:result.state,output:result.output,checks:['public TLS pairing','WebSocket recovery and dispatch','automatic CPU qualification','cloud selection','artifact result','cloud pause'],agentErrors:errors},null,2));
  console.log('PASS cloud software chain: HTTPS pairing, WSS control, CPU qualification, task result and pause.');console.log('Report: '+path.join(dir,'result.json'));
 }catch(error){fs.writeFileSync(path.join(dir,'failure.json'),JSON.stringify({error:error.message,agentErrors:errors},null,2));console.error('Diagnostic report: '+path.join(dir,'failure.json'));throw error;}finally{
  if(host&&host.connected){const exit=new Promise(r=>host.once('exit',r));host.send('stop');const timer=setTimeout(()=>host.kill(),15000);await exit;clearTimeout(timer);}
  if(connection)await fetch(address+'/v2/credentials/revoke',{method:'POST',headers:{Authorization:'Bearer '+connection.credential},signal:AbortSignal.timeout(15000)}).catch(()=>{});
  if(cookie)await api('/logout',{}).catch(()=>{});
 }
}
main().catch(e=>{console.error('Cloud software check failed: '+e.message);process.exitCode=1;});
