const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {X509Certificate}=require('node:crypto');
const {signTransfer,verifyTransfer,transferDigest}=require('../dist');

test('signed grants bind endpoint, app, attempt, content, direction and lifetime',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'transfer-grant-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 function identity(name){
  const key=path.join(dir,name+'.key'),cert=path.join(dir,name+'.crt');
  execFileSync(process.env.OPENSSL||'openssl',['req','-x509','-newkey','rsa:3072','-sha256','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-keyout',key,'-out',cert],{stdio:'ignore',windowsHide:true});
  return {key:fs.readFileSync(key,'utf8'),certificate:fs.readFileSync(cert,'utf8')};
 }
 const coordinator=identity('coordinator'),endpoint=identity('endpoint'),now=Date.now();
 const a={version:1,id:'grant',domain:'SIMULATED',coordinatorEpoch:1,networkEpoch:'network',workflowId:'workflow',attemptId:'attempt',appInstanceId:'app',groupId:'group',ownerPrincipalId:'owner',requesterHolderId:'phone',senderHolderId:'phone',receiverHolderId:'pc',
  endpoint:{id:'endpoint',groupId:'group',holderInstanceId:'pc',deviceId:'pc-device',epoch:'epoch',address:'https://localhost:1234/',certificate:endpoint.certificate,fingerprint:new X509Certificate(endpoint.certificate).fingerprint256.replaceAll(':','').toLowerCase()},
  ref:{artifactId:'input',contentVersion:1,contentHash:transferDigest('bytes'),schemaId:'text',schemaVersion:1},bytes:5,operation:'WRITE',proofHash:transferDigest('proof'),issuedAt:now,expiresAt:now+30000};
 const delivery={...a,version:2,producerAttemptId:'producer',deliveryId:'delivery',artifactExpiresAt:now+3600000};
 const push=signTransfer(delivery,coordinator.key);
 assert.deepEqual(verifyTransfer(push,coordinator.certificate,'SIMULATED',now),delivery);
 for(const field of ['producerAttemptId','deliveryId','attemptId']){
  const tampered=structuredClone(push);tampered.authorization[field]='replacement';assert.throws(()=>verifyTransfer(tampered,coordinator.certificate,'SIMULATED',now));
 }
 assert.throws(()=>signTransfer({...delivery,producerAttemptId:a.attemptId},coordinator.key));
 assert.throws(()=>signTransfer({...delivery,version:1},coordinator.key));
 const signed=signTransfer(a,coordinator.key);
 assert.deepEqual(verifyTransfer(signed,coordinator.certificate,'SIMULATED',now),a);
 for(const change of [v=>v.appInstanceId='other',v=>v.attemptId='other',v=>v.coordinatorEpoch++,v=>v.ref.contentHash=transferDigest('other'),v=>v.bytes++,v=>v.endpoint.epoch='other',v=>v.endpoint.fingerprint='0'.repeat(64),v=>v.receiverHolderId='other',v=>v.operation='READ']){
  const mutated=structuredClone(signed);change(mutated.authorization);
  assert.throws(()=>verifyTransfer(mutated,coordinator.certificate,'SIMULATED',now));
 }
 assert.throws(()=>verifyTransfer(signed,endpoint.certificate,'SIMULATED',now));
 assert.throws(()=>verifyTransfer(signed,coordinator.certificate,'REAL',now));
 for(const time of [now-1,now+30000,NaN,Infinity])assert.throws(()=>verifyTransfer(signed,coordinator.certificate,'SIMULATED',time));
 assert.throws(()=>signTransfer({...a,expiresAt:now+60001},coordinator.key));
});
