const fs=require('node:fs'),path=require('node:path');
const {executionDigest}=require('../dist/store');
const fixture=name=>JSON.parse(fs.readFileSync(path.resolve('../../contracts/scheduling/v2/fixtures/valid/'+name+'.json'),'utf8'));
function attempt(){
  const task=fixture('TaskInstance'),record=fixture('AttemptRecord'),message=fixture('MessageEnvelope');
  record.state='ACCEPTED';record.resourcesSettled=false;record.receipt=null;record.executionDigest=executionDigest(task);
  const offer=JSON.parse(fs.readFileSync(path.resolve('../../contracts/scheduling/v2/fixtures/t2/valid/DispatchOffer.json'),'utf8'));
  offer.task=task;offer.target=fixture('ExecutionReceipt').actualTarget;offer.resources=offer.resources.filter(r=>offer.target.resourcePoolIds.includes(r.resourcePoolId));
  message.type='DispatchOffer';message.senderInstanceId='coordinator1';message.payload=JSON.stringify(offer);
  return {task,record,message,offer};
}
async function qualifySimulated(db,profile,groupId='g1'){
  if(profile.domain!=='SIMULATED')throw Error('TEST_DOMAIN_REQUIRED');
  const {executorIdentity}=require('../dist/directory');
  for(const executor of profile.executors){
    const id=JSON.stringify([groupId,profile.holderInstanceId,executor.target.targetId]);
    const row=await db.capabilityState.findUniqueOrThrow({where:{id}});
    const admission={groupId,holderInstanceId:profile.holderInstanceId,targetId:executor.target.targetId,
      identity:executorIdentity(executor),domain:'SIMULATED',revision:row.revision+1,state:'ACTIVE',reasonCode:'SIMULATED_FIXTURE',
      quality:{value:1,source:'SIMULATED',sampledAt:profile.ownerActivity.sampledAt,ttlMs:1000,unit:'score'}};
    await db.capabilityState.update({where:{id},data:{revision:admission.revision,metadataJson:JSON.stringify(admission)}});
  }
}
module.exports={fixture,attempt,qualifySimulated};
