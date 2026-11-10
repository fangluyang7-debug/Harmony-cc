/** Explicit transient refusals; storage and unknown faults are never retried by classification. */
export function retryableJobError(code:string):boolean{
  return ['NO_AVAILABLE_TARGET','NO_LEGAL_PLAN','PLANNING_BUDGET_BASELINE','ALLOTMENT_UNAVAILABLE','ALLOTMENT_ACK_PENDING','PLAN_STALE','START_BUSY'].includes(code);
}
