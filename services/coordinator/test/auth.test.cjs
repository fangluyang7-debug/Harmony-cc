const {test}=require('node:test'),assert=require('node:assert/strict');
const {once}=require('node:events');
const {WebSocket}=require('ws');
const {runtime}=require('./helpers.cjs');
const {PairingService}=require('../dist/auth');
const {pinnedRequest,pinnedOptions}=require('../dist/pinned-client');
test('pinned pairing is single-use; rotation and revocation immediately invalidate the old connection',async()=>{
  const r=await runtime();let ws;
  try{
    const invitation=await r.auth.invite('g1','p1','d1',r.url);
    const request={inviteId:invitation.inviteId,code:invitation.code,holderInstanceId:'h1'};
    await assert.rejects(pinnedRequest({...invitation,fingerprint:'0'.repeat(64)},'/v2/pair',request),/PIN_MISMATCH/);
    const paired=await pinnedRequest(invitation,'/v2/pair',request);assert.equal(paired.peer.deviceId,'d1');
    await assert.rejects(pinnedRequest(invitation,'/v2/pair',request),/HTTP_401/);
    const stored=await r.db.credential.findUnique({where:{id:paired.peer.credentialId}});assert.equal(stored.metadataJson.includes(paired.credential),false);
    ws=new WebSocket(r.url.replace('https:','wss:')+'/v2/channel',{...pinnedOptions(invitation),headers:{Authorization:'Bearer '+paired.credential}});await once(ws,'open');
    const closing=once(ws,'close');const rotated=await pinnedRequest(invitation,'/v2/credentials/rotate',{},paired.credential);assert.equal((await closing)[0],1008);
    await assert.rejects(r.auth.authenticate(paired.credential),/REVOKED/);assert.equal((await r.auth.authenticate(rotated.credential)).holderInstanceId,'h1');
    await pinnedRequest(invitation,'/v2/credentials/revoke',{},rotated.credential);
    await assert.rejects(pinnedRequest(invitation,'/v2/credentials/rotate',{},rotated.credential),/HTTP_401/);
  }finally{ws?.terminate();await r.close();}
});
test('expired and forged invitations do not issue credentials; runtime domains stay separate',async()=>{
  const r=await runtime();let now=100;
  try{
    const auth=new PairingService(r.db,r.identity.cert,'SIMULATED',()=>now),invite=await auth.invite('g1','p1','d1',r.url,1);
    now=102;await assert.rejects(auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:'h1'}),/INVITE_INVALID/);
    const active=await auth.invite('g1','p1','d1',r.url);
    await assert.rejects(auth.exchange({inviteId:active.inviteId,code:'x'.repeat(24),holderInstanceId:'h1'}),/INVITE_INVALID/);
    const paired=await auth.exchange({inviteId:active.inviteId,code:active.code,holderInstanceId:'h1'});
    await assert.rejects(new PairingService(r.db,r.identity.cert,'REAL',()=>now).authenticate(paired.credential),/EXPIRED/);
    assert.equal(await r.db.credential.count(),1);
  }finally{await r.close();}
});
