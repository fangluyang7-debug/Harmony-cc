import { accumulate, canonical, costConfiguration, fitLink, admissionEvidence, PlacementRollout } from '../src';

test('success estimates are immutable and failures do not refresh successful evidence',()=>{
  const old=accumulate(undefined,10,true,100,20), next=accumulate(old,999,false,200);
  expect(old.failures).toBe(0);expect(next).toMatchObject({mean:10,successAt:100,observedAt:200,failures:1});
  expect(accumulate(old,30,true,300).mean).toBe(15);
});
test('canonical configuration is deterministic and rejects invalid bucket definitions',()=>{
  expect(canonical({b:2,a:1})).toBe(canonical({a:1,b:2}));
  expect(costConfiguration({size:25},{version:'1',parameters:[{name:'size',bucketWidth:10}]})).toEqual({model:'1',values:{size:2}});
  expect(()=>costConfiguration({},{version:'1',parameters:[{name:'x',bucketWidth:0}]})).toThrow('COST_MODEL_INVALID');
});
test('link fitting uses different sizes and rejects missing or invalid observations',()=>{
  const rows=[100,200,300].map(bytes=>({bytes,durationMs:10+bytes/2,observedAt:100}));
  expect(fitLink(rows,1000)).toEqual({bytesPerSecond:2000,fixedMs:10,observedAt:100,ttlMs:1000});
  expect(fitLink(rows.slice(0,2),1000)).toBeUndefined();
  expect(fitLink([...rows,{bytes:NaN,durationMs:2,observedAt:100}],1000)).toBeUndefined();
});
test('canary evidence uses injected time and cohort, failing closed on stale or invalid evidence',()=>{
  const config:PlacementRollout={mode:'CANARY',policyVersion:'p',expiresAt:200,killSwitch:false,allowedDevices:[],allowedCapabilities:[],sampleCount:0,minimumSamples:30,qualityPassed:true,nonInferiorityPassed:false,failureRate:0,maximumFailureRate:.1,cohortAllowed:true,canaryRate:.1};
  const evidence={sampleCount:3,failureRate:0,lastSuccessAt:99};
  expect(admissionEvidence(config,evidence,.01,false,true,100,50).cohortAllowed).toBe(true);
  expect(admissionEvidence(config,evidence,.5,false,true,100,50).cohortAllowed).toBe(false);
  expect(admissionEvidence(config,evidence,NaN,false,true,100,50).killSwitch).toBe(true);
  expect(admissionEvidence(config,evidence,.01,false,true,200,50).sampleCount).toBe(0);
});

test('startup-dominated link probes keep jitter as fixed overhead instead of multiplying it by payload size',()=>{
  const rows=[{bytes:1024,durationMs:30,observedAt:100},{bytes:8192,durationMs:18,observedAt:100},{bytes:32768,durationMs:20,observedAt:100}];
  const fit=fitLink(rows,30000)!;
  for(const row of rows)expect(fit.fixedMs+row.bytes/fit.bytesPerSecond*1000).toBeGreaterThanOrEqual(row.durationMs-1e-9);
  // 8 MiB no longer inherits 8192 copies of the 1 KiB cold-request overhead.
  expect(fit.fixedMs+8388608/fit.bytesPerSecond*1000).toBeLessThan(6000);
  expect(fit.fixedMs).toBeGreaterThan(20);
  const repeated=fitLink([...rows,{bytes:32768,durationMs:25,observedAt:101}],30000)!;
  expect(repeated.bytesPerSecond).toBeLessThanOrEqual(32768/25*1000);
  const slow=fitLink([1024,8192,32768].map(bytes=>({bytes,durationMs:10+bytes/10,observedAt:100})),30000)!;
  expect(slow.fixedMs+8388608/slow.bytesPerSecond*1000).toBeGreaterThan(30000);
});
