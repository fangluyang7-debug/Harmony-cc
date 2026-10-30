const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),https=require('node:https');
const {createHash}=require('node:crypto');
const {runtime}=require('./helpers.cjs'),{pinnedRequest}=require('../dist/pinned-client');
const {transfer,relay,pinOptions}=require('@harmony/resource-transport');
const {createArtifactEndpoint}=require('../../pc-agent/dist/artifact-endpoint');
test('coordinator and PC HTTPS data endpoints enforce peer, object, operation, schema, digest and expiry; relay verifies both hops',async()=>{
 const schemas=new Map([['test.vector:1',b=>{const v=JSON.parse(b);return Array.isArray(v)&&v.every(Number.isFinite);}]]);
 const r=await runtime({artifactSchemas:schemas});let pc;
 try{
  const invite=await r.auth.invite('g1','p1','device1',r.url),paired=await pinnedRequest(invite,'/v2/pair',{inviteId:invite.inviteId,code:invite.code,holderInstanceId:'h1'});
  const otherInvite=await r.auth.invite('g1','p2','device2',r.url),other=await pinnedRequest(otherInvite,'/v2/pair',{inviteId:otherInvite.inviteId,code:otherInvite.code,holderInstanceId:'h2'});
  const bytes=Buffer.from('[3,4]'),ref={artifactId:'input1',contentVersion:1,contentHash:createHash('sha256').update(bytes).digest('hex'),schemaId:'test.vector',schemaVersion:1};
  const descriptor={ref,groupId:'g1',ownerPrincipalId:'p1',bytes:bytes.length,expiresAt:Date.now()+60000,domain:'SIMULATED'};
  r.artifacts.register(descriptor);const write=r.artifacts.issue(descriptor,paired.peer,'WRITE');
  await transfer(invite,write,paired.credential,bytes);const read=r.artifacts.issue(descriptor,paired.peer,'READ');
  assert.deepEqual((await transfer(invite,read,paired.credential)).bytes,bytes);
  await assert.rejects(transfer(invite,read,other.credential),/REJECTED/);
  await assert.rejects(transfer(invite,{...read,ref:{...ref,artifactId:'another'}},paired.credential),/REJECTED/);
  await assert.rejects(transfer(invite,{...write,operation:'READ'},paired.credential),/REJECTED/);
  assert.throws(()=>r.artifacts.register({...descriptor,domain:'REAL'}),/INVALID/);
  assert.throws(()=>r.artifacts.register({...descriptor,ref:{...ref,schemaId:'unknown'}}),/INVALID/);
  const wrong=Buffer.from('[8,9]');
  const status=await new Promise((resolve,reject)=>{const req=https.request(new URL('/v2/artifacts/input1/1',r.url),{...pinOptions(invite),method:'PUT',headers:{Authorization:'Bearer '+write.token,'X-Device-Credential':paired.credential,'Content-Type':'application/octet-stream','Content-Length':wrong.length}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(wrong);});assert.equal(status,403);
  const expired=r.artifacts.issue(descriptor,paired.peer,'READ',1);await new Promise(resolve=>setTimeout(resolve,5));await assert.rejects(transfer(invite,expired,paired.credential),/REJECTED/);
  pc=createArtifactEndpoint({directory:path.join(r.config.dataDir,'pc-cache'),domain:'SIMULATED',key:r.identity.key,certificate:r.identity.cert,schemas,authenticate:t=>r.auth.authenticate(t)});
  await new Promise(resolve=>pc.server.listen(0,'127.0.0.1',resolve));pc.channel.register(descriptor);
  const destination={address:'https://localhost:'+pc.server.address().port,certificate:invite.certificate,fingerprint:invite.fingerprint};
  const pcWrite=pc.channel.issue(descriptor,paired.peer,'WRITE');const result=await relay(invite,read,paired.credential,destination,pcWrite,paired.credential);
  assert.equal(result.bytes,bytes.length);assert.ok(result.uploadMs>=0&&result.downloadMs>=0);
  assert.deepEqual((await transfer(destination,pc.channel.issue(descriptor,paired.peer,'READ'),paired.credential)).bytes,bytes);
  const invalid=Buffer.from('false'),bad={...descriptor,ref:{...ref,artifactId:'bad-schema',contentHash:createHash('sha256').update(invalid).digest('hex')},bytes:invalid.length};r.artifacts.register(bad);
  await assert.rejects(transfer(invite,r.artifacts.issue(bad,paired.peer,'WRITE'),paired.credential,invalid),/REJECTED/);
  await r.auth.revoke(paired.peer.credentialId);await assert.rejects(transfer(invite,read,paired.credential),/REJECTED/);
 }finally{if(pc)await new Promise(resolve=>pc.server.close(resolve));await r.close();}
});
