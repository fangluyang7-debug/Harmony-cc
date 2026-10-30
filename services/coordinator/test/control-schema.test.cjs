const {test}=require('node:test'),assert=require('node:assert/strict'),Ajv=require('ajv');
const {runtime}=require('./helpers.cjs'),{pinnedRequest}=require('../dist/pinned-client');
const {createHash,createHmac}=require('node:crypto'),{canonical}=require('@harmony/scheduler-core');
test('RecoveryRequest schema carries no caller-supplied authorization scope',()=>{
 const ajv=new Ajv();ajv.addSchema(require('../../../contracts/scheduling/v2/schema/channel.schema.json'));
 const validate=ajv.getSchema('urn:scheduling:v2:channel#/definitions/RecoveryRequest');assert.equal(validate({}),true);
 for(const value of [null,[],{groupId:'another'},{holderInstanceId:'another'},{attemptId:'a1'}])assert.equal(validate(value),false);
});
test('documented control schemas match TLS responses; malformed requests and revoked credentials cannot change quota',async()=>{
 const ajv=new Ajv();for(const name of ['protocol','resources','control'])ajv.addSchema(require('../../../contracts/scheduling/v2/schema/'+name+'.schema.json'));
 const check=(name,value)=>assert.equal(ajv.getSchema('urn:scheduling:v2:control#/definitions/'+name)(value),true,name);
 const r=await runtime();try{
  const invite=await r.auth.invite('g1','p1','device1',r.url);check('Invitation',invite);
  const request={inviteId:invite.inviteId,code:invite.code,holderInstanceId:'h1'};check('PairingRequest',request);
  const paired=await pinnedRequest(invite,'/v2/pair',request);check('PairingResponse',paired);check('Identity',await pinnedRequest(invite,'/v2/identity'));
  const input={ledgerEpoch:1,leaseRequestId:'r1',leaseMs:1000,base:[],extra:[{resourcePoolId:'ram',amount:100}]};check('AllotmentRequest',input);
  await r.allotments.confirmDevice('device1',input.extra,[{groupId:'g1',holderInstanceId:'h1',appInstanceId:null}]);
  await assert.rejects(pinnedRequest(invite,'/v2/allotments/request',{...input,holderInstanceId:'intruder'},paired.credential),/401/);
  const grant=await pinnedRequest(invite,'/v2/allotments/request',input,paired.credential);assert.equal(ajv.getSchema('urn:scheduling:v2:resources#/definitions/AllotmentGrant')(grant),true);
  const ack={allotmentId:grant.allotmentId,holderInstanceId:'h1',ledgerEpoch:1,coordinatorEpoch:1,version:1,persisted:true,settlementSeq:0,occupied:[]};
  const signature=createHmac('sha256',createHash('sha256').update(paired.credential).digest()).update(canonical(ack)).digest('base64');check('SignedAllotmentAck',{ack,signature});
  check('AllotmentAckResponse',await pinnedRequest(invite,'/v2/allotments/ack',{ack,signature},paired.credential));
  check('RevokeResponse',await pinnedRequest(invite,'/v2/credentials/revoke',{},paired.credential));
  await assert.rejects(pinnedRequest(invite,'/v2/allotments/request',input,paired.credential),/401/);
  await assert.rejects(pinnedRequest(invite,'/v2/allotments/ack',{ack,signature},paired.credential),/401/);
  for(const name of Object.keys(require('../../../contracts/scheduling/v2/schema/control.schema.json').definitions)){
   const validate=ajv.getSchema('urn:scheduling:v2:control#/definitions/'+name);assert.equal(validate({}),false,name);assert.equal(validate(null),false,name);
  }
 }finally{await r.close();}
});
