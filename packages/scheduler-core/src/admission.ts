import { PlacementRollout } from './planner';


export interface AdmissionEvidence {sampleCount:number;failureRate:number;lastSuccessAt:number|null;circuitOpen?:boolean;probeAllowed?:boolean;}
/** Longer-lived sufficiency and recent operational health are independent conditions. */
export function admissionEvidence(config:PlacementRollout,evidence:AdmissionEvidence,cohort:number,
  calibrating:boolean,canaryEligible:boolean,now:number,evidenceWindowMs:number):PlacementRollout {
  const recent=evidence.lastSuccessAt!==null&&evidence.lastSuccessAt<=now&&now-evidence.lastSuccessAt<evidenceWindowMs;
  const result={...config,killSwitch:evidence.circuitOpen===true?true:config.killSwitch,sampleCount:calibrating||recent?evidence.sampleCount:0,failureRate:evidence.failureRate};
  // A quota-limited background probe may recover after cooldown; foreground gates retain real failure rates.
  if(calibrating&&evidence.probeAllowed)return {...result,killSwitch:config.killSwitch,failureRate:0};
  if(calibrating||config.mode!=='CANARY'||config.canaryRate===undefined)return result;
  const count=config.canaryMinimumSamples??3,maximum=config.canaryMaximumFailureRate??config.maximumFailureRate;
  if(!Number.isFinite(config.canaryRate)||config.canaryRate<0||config.canaryRate>.1||
    !Number.isSafeInteger(count)||count<3||!Number.isFinite(maximum)||maximum<0||maximum>.25||!canaryEligible){
    return {...result,killSwitch:true};
  }
  if(!Number.isFinite(cohort)||cohort<0||cohort>=1)return {...result,killSwitch:true};
  // Explicit pure-task canaries gather speed evidence; this exemption never changes ACTIVE approval.
  return {...result,minimumSamples:count,maximumFailureRate:maximum,nonInferiorityPassed:true,
    cohortAllowed:config.cohortAllowed&&cohort<config.canaryRate};
}
