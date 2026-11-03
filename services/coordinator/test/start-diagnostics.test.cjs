const {test}=require('node:test'),assert=require('node:assert/strict');
const {DispatchDiagnostics}=require('../dist/dispatch-diagnostics');
test('diagnostics are bounded, group-scoped and returned as copies',()=>{
 const log=new DispatchDiagnostics(),at=Date.now();
 for(let i=0;i<600;i++)log.record({at,kind:'SNAPSHOT_REFRESH',groupId:'g',snapshotVersion:i});
 assert.equal(log.recent('g').length,512);assert.equal(log.recent('other').length,0);
 const rows=log.recent('g');rows[0].kind='mutated';assert.equal(log.recent('g')[0].kind,'SNAPSHOT_REFRESH');
 log.record({at:at+300001,kind:'START_FAILED',groupId:'g'});assert.equal(log.recent('g').length,1);
});
const {retryableJobError}=require('../dist/job-errors');
test('only explicit transient job refusals are retryable',()=>{
 for(const code of ['ALLOTMENT_ACK_PENDING','ALLOTMENT_UNAVAILABLE','PLAN_STALE','START_BUSY'])assert.equal(retryableJobError(code),true);
 for(const code of ['APP_REVOKED','JOB_CANCELLED','P2028','UNKNOWN','JOB_RECOVERY_REQUIRED'])assert.equal(retryableJobError(code),false);
});
