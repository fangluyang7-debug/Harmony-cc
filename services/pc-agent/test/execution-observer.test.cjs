const {test}=require('node:test'),assert=require('node:assert/strict');
const {ExecutionObserver}=require('../dist/execution-observer');
const fixture=require('../../../contracts/scheduling/v2/fixtures/t2/valid/DispatchOffer.json');
function offer(id='business'){const o=structuredClone(fixture);o.task.attemptId=id;o.reasonCode='BUSINESS';o.task.parameters=JSON.stringify({x:0,y:64,width:96,height:64});return o;}
test('execution evidence is opt-in, excludes calibration, bounds history, and distinguishes compute from delivery',()=>{
 const v=new ExecutionObserver(),o=offer();v.observe(o);assert.equal(v.snapshot().attempts.length,0);v.enable({domain:'SIMULATED'});
 const calibration=offer('reference');calibration.reasonCode='TRUSTED_REFERENCE';v.observe(calibration);assert.equal(v.snapshot().attempts.length,0);
 v.observe(o);v.observe(o);assert.equal(v.snapshot().attempts.length,1);assert.deepEqual(v.snapshot().attempts[0].region,{x:0,y:64,width:96,height:64});
 v.input('business',123);v.phase('business','EXECUTE');assert.equal(v.snapshot().attempts[0].state,'RUNNING');
 v.phase('business','EXECUTE',true,10);v.output('business','a'.repeat(64),456,'photo.tile');v.delivery('business','RETAINED');
 assert.equal(v.snapshot().attempts[0].sends,undefined,'publishing is not downstream delivery');
 v.update('business',{state:'SUCCEEDED',settled:true});v.sent('business','phone',456,'a'.repeat(64));v.sent('business','phone',456,'a'.repeat(64));assert.equal(v.snapshot().attempts[0].sends.length,1);
 for(let i=0;i<200;i++)v.observe(offer('bounded-'+i));assert.equal(v.snapshot().attempts.length,96);assert.ok(!v.snapshot().attempts.some(r=>r.id==='business'));
 for(let i=0;i<50;i++)v.update('bounded-199',{},'event');assert.equal(v.snapshot().attempts[0].events.length,24);
});
