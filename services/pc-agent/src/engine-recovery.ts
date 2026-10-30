import { AttemptRecordV2, ExecutionReceiptV2, TargetV2 } from '@harmony/scheduler-core';
import { DurableLedger } from './durable-ledger';

export interface EngineRecoveryQuery {attemptId:string;target:TargetV2;record:AttemptRecordV2;}
export type EngineRecoveryEvidence={state:'RUNNING'|'UNKNOWN'}|{state:'SETTLED';receipt:ExecutionReceiptV2};
/** Implemented by a trusted LOCAL adapter bound to an installed engine, never by the remote task submitter. */
export type EngineRecoveryProbe=(query:EngineRecoveryQuery)=>Promise<EngineRecoveryEvidence>;

/** Event-triggered reconciliation. No start/retry method is exposed to this adapter. */
export async function reconcileEngine(ledger:DurableLedger,attemptId:string,probe:EngineRecoveryProbe):Promise<'SETTLED'|'RUNNING'|'UNKNOWN'>{
  const entry=ledger.snapshot().entries.find(e=>e.record.attemptId===attemptId);
  if(!entry)throw Error('ATTEMPT_UNKNOWN');
  if(entry.record.resourcesSettled)return 'SETTLED';
  if(entry.record.state!=='SIDE_EFFECT_UNKNOWN')throw Error('ENGINE_RECOVERY_NOT_PENDING');
  let evidence:EngineRecoveryEvidence;
  try{evidence=await probe({attemptId,target:entry.offer.target,record:entry.record});}catch{return 'UNKNOWN';}
  if(!evidence||!['RUNNING','UNKNOWN','SETTLED'].includes(evidence.state))throw Error('ENGINE_EVIDENCE_INVALID');
  if(evidence.state==='SETTLED'){
    // settle verifies fence, plan, epoch, actual target/config and physical-settlement flag; mismatch keeps the reservation.
    ledger.settle(evidence.receipt);return 'SETTLED';
  }
  return evidence.state;
}
