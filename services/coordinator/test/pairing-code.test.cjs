const {test}=require('node:test'),assert=require('node:assert/strict');
const {PairingService}=require('../dist/auth');
test('successful code resolutions do not exhaust the global invalid-guess budget',async()=>{
 const service=new PairingService({},'','SIMULATED',()=>1000);service.readDeviceInvite=async input=>input;
 const code=service.issuePairingCode({inviteId:'id',code:'secret',expiresAt:1000000});
 for(let round=0;round<40;round++)await Promise.all(['phone','pc-b','harmony-pc'].map(remote=>service.redeemPairingCode(code.pairingCode,'url',remote)));
});
test('numeric codes remain reusable until expiry and rate limit invalid guesses',async()=>{
 let now=1000;const service=new PairingService({},'', 'SIMULATED',()=>now);
 service.readDeviceInvite=async input=>input;
 const invite={inviteId:'id',code:'secret',expiresAt:1000000};
 const code=service.issuePairingCode(invite);assert.match(code.pairingCode,/^\d{6}$/);
 const results=await Promise.allSettled([service.redeemPairingCode(code.pairingCode,'url','peer'),service.redeemPairingCode(code.pairingCode,'url','peer')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
 const expiring=service.issuePairingCode(invite);now=expiring.pairingCodeExpiresAt;
 await assert.rejects(service.redeemPairingCode(expiring.pairingCode,'url','other'));
 for(let i=0;i<5;i++)await assert.rejects(service.redeemPairingCode('invalid','url','guesser'));
 const fresh=service.issuePairingCode({...invite,expiresAt:now+600000});
 await assert.rejects(service.redeemPairingCode(fresh.pairingCode,'url','guesser'),/RATE_LIMITED/);
 const nextService=new PairingService({},'', 'SIMULATED',()=>now);
 await assert.rejects(nextService.redeemPairingCode(fresh.pairingCode,'url','peer'));
});
