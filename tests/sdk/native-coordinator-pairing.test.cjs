const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto'),{transformSync}=require('esbuild');
function setup(){const {fixture}=require('./native-coordinator-fixture.cjs'),f=fixture();f.device('d','h');const {CoordinatorPairing}=f.load('apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorPairing.ets');return {...f,pairing:new CoordinatorPairing(f.database,{certificate:'fixture',fingerprint:'fixture'},'REAL'),fail:v=>f.sql.exec(v?"CREATE TRIGGER fail_credentials BEFORE INSERT ON Credential BEGIN SELECT RAISE(ABORT,'DISK_FAILURE'); END":"DROP TRIGGER fail_credentials"),count:()=>f.sql.prepare('SELECT COUNT(*) AS n FROM Credential').get().n};}
test('invitation is one-use even when exchanges race',async()=>{const s=setup(),i=await s.pairing.invite('g','p','d','https://localhost:7443');const results=await Promise.allSettled([s.pairing.exchange(i.inviteId,i.code,'one'),s.pairing.exchange(i.inviteId,i.code,'two')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(s.count(),1);});
test('credential write failure rolls back invitation consumption',async()=>{const s=setup(),i=await s.pairing.invite('g','p','d','https://localhost:7443');s.fail(true);await assert.rejects(s.pairing.exchange(i.inviteId,i.code,'h'),/DISK_FAILURE/);s.fail(false);assert.equal((await s.pairing.exchange(i.inviteId,i.code,'h')).peer.deviceId,'d');});
test('short code can resolve the same invitation repeatedly until expiry',async()=>{const s=setup(),i=await s.pairing.invite('g','p','d','https://localhost:7443'),issued=s.pairing.issuePairingCode(i);assert.match(issued.pairingCode,/^\d{6}$/);const b=await s.pairing.redeemPairingCode(issued.pairingCode,'https://localhost:7443','remote');assert.equal(b.holderInstanceId,'h');assert.equal(b.invitation.tlsMode,'pinned');assert.equal(b.invitation.code,i.code);assert.equal(b.domain,'REAL');assert.deepEqual(await s.pairing.redeemPairingCode(issued.pairingCode,'https://localhost:7443','remote'),b);});

test('same installation leaves and rejoins with valid invitation, without accepting a different device',async()=>{
 const s=setup(),installation=crypto.randomUUID(),i=await s.pairing.invite('g','p','d','https://localhost:7443'),issued=s.pairing.issuePairingCode(i);
 const first=await s.pairing.exchange(i.inviteId,i.code,'h',installation);
 await assert.rejects(s.pairing.exchange(i.inviteId,i.code,'h',installation),/HOLDER_ALREADY_REGISTERED/);
 await s.pairing.leave(first.peer);
 assert.equal(s.sql.prepare('SELECT revoked FROM Credential WHERE id=?').get(first.peer.credentialId).revoked,1);
 await assert.rejects(s.pairing.exchange(i.inviteId,i.code,'h',crypto.randomUUID()),/INVITE_INVALID/);
 const bootstrap=await s.pairing.redeemPairingCode(issued.pairingCode,'https://localhost:7443','remote');
 const second=await s.pairing.exchange(bootstrap.invitation.inviteId,bootstrap.invitation.code,'h',installation);
 assert.notEqual(second.credential,first.credential);
 assert.equal(s.sql.prepare('SELECT COUNT(*) n FROM Credential WHERE revoked=0').get().n,1);
 await s.pairing.leave(second.peer);
 const row=s.sql.prepare('SELECT metadataJson FROM Invite WHERE id=?').get(i.inviteId),data=JSON.parse(row.metadataJson);data.expiresAt=Date.now()-1;
 s.sql.prepare('UPDATE Invite SET metadataJson=? WHERE id=?').run(JSON.stringify(data),i.inviteId);
 await assert.rejects(s.pairing.exchange(i.inviteId,i.code,'h',installation),/INVITE_INVALID/);
});
test('bootstrap rejects wrong secrets, wrong membership and consumed invitations',async()=>{const s=setup(),i=await s.pairing.invite('g','p','d','https://localhost:7443');await assert.rejects(s.pairing.readDeviceInvite(i.inviteId,'A'.repeat(24),'https://localhost:7443'),/INVITE_INVALID/);const wrong=await s.pairing.invite('other','p','d','https://localhost:7443');await assert.rejects(s.pairing.readDeviceInvite(wrong.inviteId,wrong.code,'https://localhost:7443'),/INVITE_INVALID/);await s.pairing.exchange(i.inviteId,i.code,'h');await assert.rejects(s.pairing.readDeviceInvite(i.inviteId,i.code,'https://localhost:7443'),/INVITE_INVALID/);});
test('short-code guesses use the Windows per-remote attempt limit',async()=>{const s=setup();for(let n=0;n<5;n++)await assert.rejects(s.pairing.redeemPairingCode('invalid','https://localhost:7443','remote'),/PAIRING_REJECTED/);await assert.rejects(s.pairing.redeemPairingCode('invalid','https://localhost:7443','remote'),/PAIRING_RATE_LIMITED/);});
test('space switch revokes old credentials only after settlement and rolls back a busy switch',async()=>{
 const s=setup(),installation=crypto.randomUUID(),i=await s.pairing.invite('g','p','d','https://localhost:7443');const first=await s.pairing.exchange(i.inviteId,i.code,'h',installation);
 s.device('d2','h2','g2');const next=await s.pairing.invite('g2','p','d2','https://localhost:7443');
 s.sql.prepare('INSERT INTO Attempt (id,groupId,workflowId,nodeId,executionDigest,state,holderInstanceId,recordJson,taskJson) VALUES (?,?,?,?,?,?,?,?,?)').run('attempt','g','w','n','digest','RUNNING','h',JSON.stringify({resourcesSettled:false}),'{}');
 await assert.rejects(s.pairing.exchange(next.inviteId,next.code,'h2',installation,'d',['d']),/SPACE_SWITCH_BUSY/);
 assert.equal(s.sql.prepare('SELECT revoked FROM Credential WHERE id=?').get(first.peer.credentialId).revoked,0);
 assert.equal(JSON.parse(s.sql.prepare('SELECT metadataJson FROM Invite WHERE id=?').get(next.inviteId).metadataJson).used,false);
 s.sql.prepare('UPDATE Attempt SET recordJson=? WHERE id=?').run(JSON.stringify({resourcesSettled:true}),'attempt');const revoked=[];s.pairing.onRevoked(id=>revoked.push(id));
 await s.pairing.exchange(next.inviteId,next.code,'h2',installation,'d',['d']);assert.deepEqual(revoked,[first.peer.credentialId]);assert.equal(s.sql.prepare('SELECT revoked FROM Credential WHERE id=?').get(first.peer.credentialId).revoked,1);
 assert.equal(JSON.parse(s.sql.prepare('SELECT metadataJson FROM Device WHERE id=?').get(JSON.stringify(['space-installation',installation])).metadataJson).deviceId,'d2');
});
test('holder cannot be rebound to another device or duplicated while credential is active',async()=>{const s=setup();let i=await s.pairing.invite('g','p','d','https://localhost:7443');await s.pairing.exchange(i.inviteId,i.code,'h');i=await s.pairing.invite('g','p','d','https://localhost:7443');await assert.rejects(s.pairing.exchange(i.inviteId,i.code,'h'),/HOLDER_ALREADY_REGISTERED/);s.device('other','other-holder');i=await s.pairing.invite('g','p','other','https://localhost:7443');await assert.rejects(s.pairing.exchange(i.inviteId,i.code,'h'),/HOLDER_BINDING_CHANGED/);});
