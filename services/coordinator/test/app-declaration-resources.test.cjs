const {test}=require('node:test'),assert=require('node:assert/strict');
const {runtime}=require('./helpers.cjs');
const {pinnedRequest}=require('../dist/pinned-client');
test('public App declarations reject resource policy and inherit the physical device budget',async()=>{
 const r=await runtime();try{
 const capacity=[{resourcePoolId:'cpu',amount:12},{resourcePoolId:'ram',amount:8*1073741824}];
 const invite=await r.auth.invite('group','owner','phone',r.url),owner=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:'agent'});
 await r.allotments.confirmDevice('phone',capacity,[{groupId:'group',holderInstanceId:'agent',appInstanceId:null}]);
 const declaration={label:'auto app',allowedContracts:['text.count.v1']};
 for(const field of ['resources','offlineBase','onlineExtra','maxConcurrent'])await assert.rejects(r.apps.registerDeclaration(owner.peer,{...declaration,[field]:field==='maxConcurrent'?2:[]},r.url),/APP_DECLARATION_FIELDS_INVALID/);
 const registration=await pinnedRequest(invite,'/v2/apps/registrations',declaration,owner.credential),exchange=await r.apps.exchange({registrationId:registration.registrationId,code:registration.code});
 assert.deepEqual(exchange.onlineExtra,capacity);assert.deepEqual(exchange.offlineBase,[]);assert.equal(exchange.quota.maxConcurrent,64);
 await assert.rejects(r.apps.registerDeclaration(exchange.peer,declaration,r.url),/DEVICE_OWNER_CREDENTIAL_REQUIRED/);
 }finally{await r.close();}
});
