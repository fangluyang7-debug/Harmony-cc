const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {ArtifactChannel}=require('../dist');
test('status polling reuses grants only for the same registered result and authenticated peer',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'result-poll-'));let now=100;
 const channel=new ArtifactChannel(dir,'SIMULATED',async()=>{throw Error('NO_NETWORK');},new Map([['text:1',()=>true]]),()=>now,{objectBytes:100,cacheBytes:100,concurrent:1,maxTokens:2});
 const ref={artifactId:'out',contentVersion:1,contentHash:'a'.repeat(64),schemaId:'text',schemaVersion:1};
 const descriptor={ref,groupId:'g',ownerPrincipalId:'user',bytes:1,expiresAt:90000,domain:'SIMULATED'};
 const peer={groupId:'g',principalId:'user',holderInstanceId:'app'};
 channel.register(descriptor);
 try{
  const token=channel.issueStatusRead(descriptor,peer).token;
  for(let i=0;i<16;i++)assert.equal(channel.issueStatusRead(descriptor,peer).token,token);
  assert.notEqual(channel.issueStatusRead(descriptor,{...peer,holderInstanceId:'other'}).token,token);
  assert.throws(()=>channel.issue(descriptor,peer,'WRITE'),/ARTIFACT_GRANT_INVALID/);
  now+=29500;assert.equal(channel.issueStatusRead(descriptor,peer).token,token);
  now+=1500;assert.notEqual(channel.issueStatusRead(descriptor,peer).token,token);
  assert.equal(channel.forget(descriptor),true);
  assert.throws(()=>channel.issueStatusRead(descriptor,peer),/ARTIFACT_GRANT_INVALID/);
 }finally{channel.forget(descriptor);fs.rmdirSync(dir);}
});
