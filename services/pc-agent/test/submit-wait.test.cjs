const {test}=require('node:test'),assert=require('node:assert/strict');
const {submitWhenAvailable}=require('../dist/submit-wait');
test('submission waits only for explicit unavailable capacity using the same request identity',async()=>{
 const metadata={requestId:'same'},requests=[];let notices=0;
 const result=await submitWhenAvailable(async(route,body)=>{requests.push(body);if(requests.length<3)throw Error('CONTROL_REQUEST_REJECTED:NO_AVAILABLE_TARGET');return {jobId:'same'};},metadata,()=>notices++,{timeoutMs:1000,delayMs:1});
 assert.equal(result.jobId,'same');assert.equal(notices,1);assert.ok(requests.every(r=>r===metadata));
});
test('unknown delivery, rejection and exhausted capacity never trigger blind resubmission',async()=>{
 for(const code of ['CONTROL_TIMEOUT','CONTROL_REQUEST_REJECTED:JOB_CONFLICT','JOB_REJECTED']){let calls=0;await assert.rejects(submitWhenAvailable(async()=>{calls++;throw Error(code);},{},()=>{}),new RegExp(code));assert.equal(calls,1);}
 await assert.rejects(submitWhenAvailable(async()=>{throw Error('CONTROL_REQUEST_REJECTED:NO_AVAILABLE_TARGET');},{},()=>{},{timeoutMs:0,delayMs:1}),/^Error: NO_AVAILABLE_TARGET$/);
});
