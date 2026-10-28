import { createHash } from 'node:crypto';
import { PlacementRollout } from './workflow-placement-planner';
import { COST_WINDOW_MS } from './runtime-cost-store';

export interface AdmissionEvidence {sampleCount:number;failureRate:number;lastSuccessAt:number|null;circuitOpen?:boolean;probeAllowed?:boolean;}
/** Longer-lived sufficiency and recent operational health are independent conditions. */
export function admissionEvidence(config:PlacementRollout,evidence:AdmissionEvidence,trialKey:string,
  calibrating=false,canaryEligible=false,now=Date.now()):PlacementRollout {
  const recent=evidence.lastSuccessAt!==null&&evidence.lastSuccessAt<=now&&now-evidence.lastSuccessAt<COST_WINDOW_MS;
  const result={...config,killSwitch:evidence.circuitOpen===true?true:config.killSwitch,sampleCount:calibrating||recent?evidence.sampleCount:0,failureRate:evidence.failureRate};
  // A quota-limited background probe may recover after cooldown; foreground gates retain real failure rates.
  if(calibrating&&evidence.probeAllowed)return {...result,killSwitch:config.killSwitch,failureRate:0};
  if(calibrating||config.mode!=='CANARY'||config.canaryRate===undefined)return result;
  const count=config.canaryMinimumSamples??3,maximum=config.canaryMaximumFailureRate??config.maximumFailureRate;
  if(!Number.isFinite(config.canaryRate)||config.canaryRate<0||config.canaryRate>.1||
    !Number.isSafeInteger(count)||count<3||!Number.isFinite(maximum)||maximum<0||maximum>.25||!canaryEligible){
    return {...result,killSwitch:true};
  }
  const cohort=createHash('sha256').update(config.policyVersion+':'+trialKey).digest().readUInt32BE(0)/0x100000000;
  // Explicit pure-task canaries gather speed evidence; this exemption never changes ACTIVE approval.
  return {...result,minimumSamples:count,maximumFailureRate:maximum,nonInferiorityPassed:true,
    cohortAllowed:config.cohortAllowed&&cohort<config.canaryRate};
}
