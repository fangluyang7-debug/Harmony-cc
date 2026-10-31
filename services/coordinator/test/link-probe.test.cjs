const {test}=require('node:test'),assert=require('node:assert/strict');
const {runtime}=require('./helpers.cjs'),{allotmentTransport}=require('../../pc-agent/dist/allotment-client');
test('authenticated relay probes are bounded, direction-specific and reject malformed or revoked requests',async()=>{
  const r=await runtime();try{
    const invite=await r.auth.invite('probe-group','probe-owner','probe-device',r.url),paired=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:'probe-holder'});
    const transport=allotmentTransport({address:invite.address,certificate:invite.certificate,fingerprint:invite.fingerprint,credential:paired.credential,domain:'SIMULATED'});
    const request=body=>transport('/v2/link-probe',body);
    assert.deepEqual(await request({mode:'upload',bytes:4,padding:'xxxx'}),{relayId:r.identity.id,padding:''});
    assert.deepEqual(await request({mode:'download',bytes:4}),{relayId:r.identity.id,padding:'xxxx'});
    for(const body of [{mode:'upload',bytes:4,padding:'bad'},{mode:'download',bytes:32769},{mode:'download',bytes:4,padding:'x'},{mode:'unknown',bytes:4},{mode:'download',bytes:4,untrusted:true}])await assert.rejects(request(body));
    await r.auth.revoke(paired.peer.credentialId);await assert.rejects(request({mode:'download',bytes:4}));
  }finally{await r.close();}
});
