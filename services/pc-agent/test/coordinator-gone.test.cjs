const {test}=require('node:test'),assert=require('node:assert/strict');
const {CoordinatorGoneDetector}=require('../dist/coordinator-gone');
const io=code=>Object.assign(Error('io'),{code});
test('an explicit coordinator shutdown (4001) is gone immediately',()=>{
  assert.equal(new CoordinatorGoneDetector().observe(Error('CHANNEL_CLOSED_4001_COORDINATOR_SHUTDOWN'),0),true);
  assert.equal(new CoordinatorGoneDetector().observe(Error('CHANNEL_CLOSED_1006'),0),false);
});
test('only 20 s of continuous provable unreachability counts; timeouts and gaps do not',()=>{
  const d=new CoordinatorGoneDetector();
  for(let t=0;t<20000;t+=2000)assert.equal(d.observe(io('ECONNREFUSED'),t),false);
  assert.equal(d.observe(io('EHOSTUNREACH'),20000),true);
  const timeouts=new CoordinatorGoneDetector();
  for(let t=0;t<=40000;t+=2000)assert.equal(timeouts.observe(io('ETIMEDOUT'),t),false,'ambiguous timeouts never clear a pairing');
  const gap=new CoordinatorGoneDetector();
  gap.observe(io('ECONNREFUSED'),0);gap.observe(io('ECONNREFUSED'),6000);
  assert.equal(gap.observe(io('ECONNREFUSED'),20000),false,'a quiet gap means the coordinator answered; the window restarts');
  assert.equal(gap.observe(io('ECONNREFUSED'),40000),false);
  for(let t=42000;t<=60000;t+=2000)gap.observe(io('ECONNREFUSED'),t);
  assert.equal(gap.observe(io('ECONNREFUSED'),62000),true);
});
