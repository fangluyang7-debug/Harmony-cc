const {test}=require('node:test'),assert=require('node:assert/strict');
const {QualificationService}=require('../dist/qualification');
test('unchanged missing-pack evidence does not increment revisions or trigger snapshot rebuilding',async()=>{
 let admission={identity:'identity',revision:1,quality:{sampledAt:1}},saved=null,writes=0,now=10;
 const tx={capabilityState:{findUnique:async()=>({revision:admission.revision,metadataJson:JSON.stringify(admission)}),update:async x=>{admission=JSON.parse(x.data.metadataJson);writes++;}},calibrationJob:{findUnique:async()=>saved,upsert:async x=>{saved=x.update;}}};
 const service=Object.create(QualificationService.prototype);Object.assign(service,{db:{$transaction:f=>f(tx)},directory:{domain:'SIMULATED'},policy:{evidenceTtlMs:60000},now:()=>now});
 const peer={groupId:'group',holderInstanceId:'holder'},job={identity:'identity',expiresAt:0,quality:null,next:0};
 await service.publish(peer,'target',job,'SUSPENDED','TRUSTED_PACK_REQUIRED');now=20;
 await service.publish(peer,'target',job,'SUSPENDED','TRUSTED_PACK_REQUIRED');assert.equal(writes,1);
 job.next++;await service.publish(peer,'target',job,'SUSPENDED','TRUSTED_PACK_REQUIRED');assert.equal(writes,2);assert.equal(JSON.parse(saved.metadataJson).next,1);
 await service.publish(peer,'target',job,'WAITING_WINDOW','CALIBRATION_PAUSED');assert.equal(writes,3);
});
