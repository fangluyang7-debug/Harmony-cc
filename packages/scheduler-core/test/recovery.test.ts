import { recoveryAction } from '../src';
test('recovery never replays old attempts and unsettled capacity stays held',()=>{
  expect(recoveryAction('PURE','RUNNING',false)).toBe('QUERY_ENGINE');
  expect(recoveryAction('PURE','ACCEPTED',false)).toBe('QUERY_HOLDER');
  expect(recoveryAction('PURE','FAILED',false)).toBe('WAIT_SETTLEMENT');
  expect(recoveryAction('PURE','FAILED',true)).toBe('ALLOW_NEW_ATTEMPT');
  expect(recoveryAction('IDEMPOTENT_WRITE','FAILED',true)).toBe('QUERY_IDEMPOTENCY_KEY');
  expect(recoveryAction('TRANSACTIONAL','SIDE_EFFECT_UNKNOWN',true)).toBe('QUERY_TRANSACTION');
  expect(recoveryAction('NO_REPLAY','FAILED',true)).toBe('MANUAL_RECONCILIATION');
  expect(recoveryAction('unknown','FAILED',true)).toBe('MANUAL_RECONCILIATION');
});
