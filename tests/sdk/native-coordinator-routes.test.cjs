const {test}=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('./native-coordinator-fixture.cjs');
function setup(){const f=fixture(),root='apps/harmony/scheduler/src/main/ets/v2/coordinator/';const identity={certificate:'certificate-fixture',fingerprint:'fingerprint-fixture'},address='https://192.168.1.2:7443';const pairing=new (f.load(root+'CoordinatorPairing.ets').CoordinatorPairing)(f.database,identity,'REAL');return {...f,pairing,admin:new (f.load(root+'CoordinatorLocalAdmin.ets').CoordinatorLocalAdmin)(f.database,pairing,'owner',address),routes:new (f.load(root+'CoordinatorRoutes.ets').CoordinatorRoutes)(pairing,identity,address,7)};}
const request=(path,body,remoteAddress='192.168.1.3')=>({path,method:body===undefined?'GET':'POST',body:Buffer.from(body===undefined?'':JSON.stringify(body)),authorization:'',remoteAddress});

test('native device leave endpoint revokes credential and supports same-code rejoin',async()=>{
 const s=setup(),space=await s.admin.ensureDefaultSpace(),invite=await s.admin.inviteDevice(space,'phone');
 const {CoordinatorCredentials}=s.load('apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorCredentials.ets');
 s.routes.installAllotments(new CoordinatorCredentials(s.database,'REAL'),{});
 const payload={inviteId:invite.bootstrap.invitation.inviteId,code:invite.bootstrap.invitation.code,holderInstanceId:invite.bootstrap.holderInstanceId,installationId:require('node:crypto').randomUUID()};
 const first=JSON.parse((await s.routes.handle(request('/v2/pair',payload))).body);
 const leave={...request('/v2/devices/leave',{}),authorization:'Bearer '+first.credential};
 assert.equal((await s.routes.handle(leave)).status,200);
 assert.notEqual((await s.routes.handle(leave)).status,200);
 assert.equal((await s.routes.handle(request('/v2/pairing/code',{code:invite.pairing.pairingCode}))).status,200);
 assert.equal((await s.routes.handle(request('/v2/pair',payload))).status,200);
});
test('native administration and existing client pairing HTTP contract work end to end',async()=>{
 const s=setup(),space=await s.admin.createSpace('演示空间'),invite=await s.admin.inviteDevice(space,'鸿蒙执行设备');
 assert.equal(invite.qrPayload,invite.bootstrap.invitation.address+'/#device='+invite.bootstrap.invitation.inviteId+'.'+invite.bootstrap.invitation.code+'&pin='+invite.bootstrap.invitation.fingerprint);
 let response=await s.routes.handle(request('/v2/pairing/certificate'));assert.equal(response.status,200);assert.equal(response.contentType,'application/x-pem-file');
 response=await s.routes.handle(request('/v2/pairing/code',{code:invite.pairing.pairingCode}));assert.equal(response.status,200);const bootstrap=JSON.parse(response.body);assert.equal(bootstrap.invitation.groupId,space);assert.equal(bootstrap.contribution.capacityMode,'auto');
 const payload={inviteId:bootstrap.invitation.inviteId,code:bootstrap.invitation.code,holderInstanceId:bootstrap.holderInstanceId};response=await s.routes.handle(request('/v2/pair',payload));assert.equal(response.status,200);assert.equal(JSON.parse(response.body).epoch,7);assert.match(JSON.parse(response.body).credential,/^[A-Za-z0-9_-]{43}$/);
 assert.equal((await s.routes.handle(request('/v2/pair',payload))).status,401);
 assert.equal((await s.routes.handle(request('/v2/health/ready'))).status,503);
});
test('pairing rejects unknown fields and invalid input without exposing credentials',async()=>{const s=setup();for(const body of [null,[],{code:'1',admin:true},{code:123},{}])assert.equal((await s.routes.handle(request('/v2/pairing/code',body))).status,401);await assert.rejects(s.admin.inviteDevice('not-owned','device'),/SPACE_FORBIDDEN/);assert.equal(s.sql.prepare('SELECT COUNT(*) n FROM SpaceDevice').get().n,0);});
test('coordinator automatically creates one durable default space across concurrent starts and restarts',async()=>{const s=setup();const ids=await Promise.all([s.admin.ensureDefaultSpace(),s.admin.ensureDefaultSpace()]);assert.equal(ids[0],ids[1]);assert.equal(s.sql.prepare('SELECT COUNT(*) n FROM TeamSpace').get().n,1);assert.equal(await s.admin.ensureDefaultSpace(),ids[0]);const invite=await s.admin.inviteDevice(ids[0],'node');assert.equal(invite.bootstrap.invitation.groupId,ids[0]);});
test('upgrade reuses existing owned space and preserves paired devices',async()=>{const s=setup();const id=await s.admin.createSpace('existing');await s.admin.inviteDevice(id,'existing-device');assert.equal(await s.admin.ensureDefaultSpace(),id);assert.equal(s.sql.prepare('SELECT COUNT(*) n FROM TeamSpace').get().n,1);assert.equal(s.sql.prepare('SELECT COUNT(*) n FROM SpaceDevice').get().n,1);});
