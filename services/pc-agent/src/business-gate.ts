import { DispatchOfferV2, ExecutorV2, CapabilityAdmissionV2, canonical, sampleUsableV2, validCapabilityAdmissionV2 } from '@harmony/scheduler-core';
import { createHash } from 'node:crypto';

/** Local policy gate. Admission evidence comes from an authenticated coordinator, never from the task itself. */
export function requireBusinessQualification(offer:DispatchOfferV2,executor:ExecutorV2,admission:CapabilityAdmissionV2,holderInstanceId:string,domain:'REAL'|'SIMULATED',now:number){
  const identity=createHash('sha256').update(canonical({target:executor.target,contract:executor.contract,model:executor.model,resources:executor.resources,configurations:executor.configurations})).digest('hex');
  if(!validCapabilityAdmissionV2(admission)||admission.domain!==domain||admission.groupId!==offer.task.groupId||admission.holderInstanceId!==holderInstanceId||admission.targetId!==offer.target.targetId||
    !['CANARY','ACTIVE'].includes(admission.state)||admission.identity!==identity||!sampleUsableV2(admission.quality,now,domain)||
    canonical(offer.target)!==canonical(executor.target)||canonical(offer.task.contract)!==canonical(executor.contract)||canonical(offer.resources)!==canonical(executor.resources)||executor.model!==null||
    offer.allowedConfigs.some(c=>!executor.configurations.some(local=>canonical(c)===canonical(local))))throw Error('CAPABILITY_NOT_QUALIFIED');
}
