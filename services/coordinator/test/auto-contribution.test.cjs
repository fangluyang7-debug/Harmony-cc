const {test}=require('node:test'),assert=require('node:assert/strict');
const {autoContribution,measuredCapacity,capacityVector}=require('../dist/spaces');
const MiB=1048576,GiB=1073741824;
const base={ownerMode:'dedicated',maxCpuThreads:2,maxMemoryBytes:GiB,reserveMemoryBytes:GiB,capacityMode:'auto'};

test('measurement accepts the legacy CPU/RAM payload and an explicit VRAM figure',()=>{
 assert.deepEqual(measuredCapacity({cpuThreads:8,totalMemoryBytes:16*GiB}),{cpuThreads:8,totalMemoryBytes:16*GiB,vramBytes:null});
 assert.deepEqual(measuredCapacity({cpuThreads:8,totalMemoryBytes:16*GiB,vramBytes:0}),{cpuThreads:8,totalMemoryBytes:16*GiB,vramBytes:0});
 assert.throws(()=>measuredCapacity({cpuThreads:8,totalMemoryBytes:16*GiB,vramBytes:-1}),/MEASUREMENT_INVALID/);
 assert.throws(()=>measuredCapacity({cpuThreads:8,totalMemoryBytes:16*GiB,gpu:1}),/MEASUREMENT_INVALID/);
});

test('an opened GPU backend turns into a VRAM share with 256 MiB kept for the desktop',()=>{
 const next=autoContribution(base,{cpuThreads:16,totalMemoryBytes:32*GiB,vramBytes:8*GiB});
 assert.equal(next.maxVramBytes,8*GiB-256*MiB);
 assert.equal(next.maxCpuThreads,15);
 assert.equal(next.reserveMemoryBytes,512*MiB);
 assert.equal(next.maxMemoryBytes,32*GiB-512*MiB);
 assert.deepEqual(capacityVector(next).map(r=>r.resourcePoolId),['cpu','ram','gpu','vram']);
});

test('no GPU backend (0 bytes) removes an earlier VRAM share; unknown keeps it',()=>{
 const withGpu={...base,maxVramBytes:4*GiB};
 assert.equal(autoContribution(withGpu,{cpuThreads:null,totalMemoryBytes:null,vramBytes:0}).maxVramBytes,undefined);
 assert.equal(autoContribution(withGpu,{cpuThreads:null,totalMemoryBytes:null,vramBytes:null}).maxVramBytes,4*GiB);
 assert.equal(autoContribution(withGpu,{cpuThreads:null,totalMemoryBytes:null,vramBytes:600*MiB}).maxVramBytes,undefined,'under 512 MiB usable is not offered');
 assert.deepEqual(capacityVector(autoContribution(withGpu,{cpuThreads:null,totalMemoryBytes:null,vramBytes:0})).map(r=>r.resourcePoolId),['cpu','ram']);
});
