// Uses an invitation copied from the native coordinator UI. Credentials are not printed.
const fs=require('node:fs'),https=require('node:https'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const [file,code,forwardPort]=process.argv.slice(2),bootstrap=JSON.parse(fs.readFileSync(file,'utf8')),invitation=bootstrap.invitation;
let credential='';
assert.equal(new crypto.X509Certificate(invitation.certificate).fingerprint256.replaceAll(':','').toLowerCase(),invitation.fingerprint);
function request(path,body){return new Promise((resolve,reject)=>{const data=JSON.stringify(body),url=new URL(path,invitation.address);const forward=forwardPort?{hostname:'127.0.0.1',port:Number(forwardPort),checkServerIdentity:(_host,cert)=>require('node:tls').checkServerIdentity(url.hostname,cert)}:{};const req=https.request(url,{...forward,method:'POST',ca:invitation.certificate,rejectUnauthorized:true,headers:{'content-type':'application/json','content-length':Buffer.byteLength(data),authorization:'Bearer '+credential},agent:false},response=>{let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(text)}));});const timer=setTimeout(()=>req.destroy(Error('Request timeout')),5000);req.on('close',()=>clearTimeout(timer));req.on('error',reject);req.end(data);});}
(async()=>{
 const redeemed=await request('/v2/pairing/code',{code});assert.equal(redeemed.status,200);assert.equal(redeemed.body.invitation.inviteId,invitation.inviteId);
 const reused=await request('/v2/pairing/code',{code});assert.equal(reused.status,401);
 const input={inviteId:invitation.inviteId,code:invitation.code,holderInstanceId:bootstrap.holderInstanceId,installationId:crypto.randomUUID()};
 const pair=await request('/v2/pair',input);assert.equal(pair.status,200);assert.match(pair.body.credential,/^[A-Za-z0-9_-]{43}$/);
 const replay=await request('/v2/pair',input);assert.equal(replay.status,401);
 if(process.argv.includes('--allotments')){
  credential=pair.body.credential;
  const settings=await request('/v2/device-settings',{measured:{cpuThreads:12,totalMemoryBytes:12*1073741824,vramBytes:0}});assert.equal(settings.status,200);assert.equal(settings.body.settings.maxCpuThreads,11);
  const issued=await request('/v2/allotments/request',{ledgerEpoch:1,leaseRequestId:crypto.randomUUID(),leaseMs:60000,base:[],extra:[{resourcePoolId:'cpu',amount:2},{resourcePoolId:'ram',amount:268435456}]});assert.equal(issued.status,200);
  const {signature,...unsigned}=issued.body;const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v!==null&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
  assert.ok(crypto.verify('sha256',Buffer.from(canonical(unsigned)),invitation.certificate,Buffer.from(signature,'base64')));
  const g=issued.body,ack={allotmentId:g.allotmentId,holderInstanceId:g.holderInstanceId,ledgerEpoch:g.ledgerEpoch,coordinatorEpoch:g.coordinatorEpoch,version:g.version,persisted:true,settlementSeq:0,occupied:[]};
  const ackSignature=crypto.createHmac('sha256',crypto.createHash('sha256').update(credential).digest()).update(canonical(ack)).digest('base64');
  assert.equal((await request('/v2/allotments/ack',{ack,signature:ackSignature})).status,200);
  assert.equal((await request('/v2/allotments/ack',{ack,signature:'A'.repeat(43)+'='})).status,401);
  console.log('Test-device measurement accepted; RSA grant signature verified; HMAC acknowledgement accepted; invalid signature rejected. Measurements are synthetic test input, not physical device telemetry.');
 }
 console.log(JSON.stringify({testedAt:new Date().toISOString(),address:invitation.address,certificateVerified:true,codeRedeemed:redeemed.status,codeReplayRejected:reused.status,paired:pair.status,inviteReplayRejected:replay.status,epoch:pair.body.epoch},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
