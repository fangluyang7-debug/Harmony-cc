const {test}=require('node:test'),assert=require('node:assert/strict');
const {gpuObservation}=require('../dist/device-telemetry');
test('NVIDIA measurements preserve zero and never turn unavailable readings into zero',()=>{
 assert.deepEqual(gpuObservation('NVIDIA RTX 4060, 0, 47'),{gpuName:'NVIDIA RTX 4060',gpuPercent:0,gpuTemperatureC:47});
 assert.deepEqual(gpuObservation('NVIDIA RTX 4060, [N/A], [N/A]'),{gpuName:'NVIDIA RTX 4060',gpuPercent:null,gpuTemperatureC:null});
});
