/** Recommendations never authorize replay of an existing attempt. */
export type RecoveryAction='QUERY_HOLDER'|'QUERY_ENGINE'|'RETURN_RECEIPT'|'WAIT_SETTLEMENT'|'ALLOW_NEW_ATTEMPT'|'QUERY_IDEMPOTENCY_KEY'|'QUERY_TRANSACTION'|'MANUAL_RECONCILIATION';
export function recoveryAction(sideEffectPolicy:string,state:string,resourcesSettled:boolean):RecoveryAction {
  if(state==='OFFERED'||state==='ACCEPTED')return 'QUERY_HOLDER';
  if(state==='RUNNING')return 'QUERY_ENGINE';
  if(state==='SUCCEEDED')return 'RETURN_RECEIPT';
  if(!resourcesSettled)return 'WAIT_SETTLEMENT';
  switch(sideEffectPolicy){
    case 'PURE':return 'ALLOW_NEW_ATTEMPT';
    case 'IDEMPOTENT_WRITE':return 'QUERY_IDEMPOTENCY_KEY';
    case 'TRANSACTIONAL':return 'QUERY_TRANSACTION';
    default:return 'MANUAL_RECONCILIATION';
  }
}
