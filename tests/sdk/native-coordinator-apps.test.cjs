const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./native-coordinator-fixture.cjs');
async function setup(){const f=fixture(),root='apps/harmony/scheduler/src/main/ets/v2/coordinator/';f.device('d','h');const credentials=new (f.load(root+'CoordinatorCredentials.ets').CoordinatorCredentials)(f.database,'REAL'),owner=await credentials.issueDevice('g','p','d','h');const allotments=new (f.load(root+'CoordinatorAllotments.ets').CoordinatorAllotments)(f.database,{sign:async()=> 'A'.repeat(64),verifyAck:async()=>true},7);await allotments.confirmDevice('d',[{resourcePoolId:'cpu',amount:11},{resourcePoolId:'ram',amount:8*1073741824}],[{groupId:'g',holderInstanceId:'h',appInstanceId:null}]);const apps=new (f.load(root+'CoordinatorApps.ets').CoordinatorApps)(f.database,{certificate:'fixture',fingerprint:'fixture'},'https://localhost:7443');return {...f,apps,credentials,owner,allotments};}
test('app declarations obtain central capacity, one-use credentials and a scoped application grant',async()=>{
 const f=await setup(),invite=await f.apps.register(f.owner.peer,{label:'soleAI',allowedContracts:['catalog.filter.v1']});
 const exchanged=await f.apps.exchange(invite.registrationId,invite.code),peer=await f.credentials.authenticate(exchanged.credential),context=await f.apps.context(peer);
 assert.equal(context.identity.appInstanceId,invite.appInstanceId);assert.equal(context.deviceCapacity[0].amount,11);assert.equal(context.quota.maxConcurrent,64);assert.deepEqual(context.offlineBase,[]);
 await assert.rejects(f.credentials.authenticateDevice(exchanged.credential),/DEVICE_OWNER_CREDENTIAL_REQUIRED/);
 await assert.rejects(f.apps.exchange(invite.registrationId,invite.code),/APP_INVITATION_INVALID/);
 const grant=await f.allotments.issue(peer,{ledgerEpoch:1,leaseRequestId:'one',leaseMs:60000,base:[],extra:context.onlineExtra});assert.equal(grant.appInstanceId,invite.appInstanceId);assert.equal(grant.extra[1].amount,8*1073741824);
 await assert.rejects(f.apps.register(peer,{label:'nested',allowedContracts:['catalog.filter.v1']}),/DEVICE_OWNER_CREDENTIAL_REQUIRED/);
 const performance=await f.apps.performance(peer);
 assert.equal(performance.quota.resources.find(r=>r.resourcePoolId==='ram').amount,68719476736);
 assert.equal(performance.onlineExtra.find(r=>r.resourcePoolId==='ram').amount,8*1073741824);
 assert.deepEqual(performance.offlineBase,[]);
 await assert.rejects(f.apps.performance(f.owner.peer),/APP_REGISTRATION_REQUIRED/);
 await f.credentials.revoke(peer.credentialId);await assert.rejects(f.credentials.authenticate(exchanged.credential),/CREDENTIAL_REVOKED/);
});
test('app cannot set quotas, claim an unapproved contract or consume an invitation twice under race',async()=>{
 const f=await setup();await assert.rejects(f.apps.register(f.owner.peer,{label:'soleAI',allowedContracts:['x'],resources:[]}),/APP_DECLARATION_FIELDS_INVALID/);
 await assert.rejects(f.apps.register(f.owner.peer,{label:'soleAI',allowedContracts:['x'],declaration:{version:1,revision:'r1',workflows:[{id:'w',capabilities:['forbidden']}]}}),/APP_DECLARATION_INVALID/);
 const i=await f.apps.register(f.owner.peer,{label:'soleAI',allowedContracts:['x']});const results=await Promise.allSettled([f.apps.exchange(i.registrationId,i.code),f.apps.exchange(i.registrationId,i.code)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
