const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs');
const {builtinCpuPacks,validateCoverage,referenceFractal}=require('@harmony/reference-capabilities'),{execute}=require('../dist/executors/fractal');
test('fractal CPU implementation matches independent known, offset and boundary reference cases',async()=>{
 const p=builtinCpuPacks().find(p=>p.manifest.packId==='render.fractal.v1');validateCoverage(p.manifest,p.cases);
 assert.ok(p.cases.every(c=>c.maxOutputBytes<=require('@harmony/resource-transport').evaluationOutputLimit));
 for(const c of p.cases){if(c.expect.kind==='REJECT'){await assert.rejects(execute(c.input,JSON.parse(c.parameters),c.config),new RegExp(c.expect.errorCode));continue;}const r=await execute(c.input,JSON.parse(c.parameters),c.config);assert.equal(await p.evaluate(c,r.output),1,c.id);}
 const r={width:2,height:2,canvasWidth:2,canvasHeight:2,offsetX:0,offsetY:0,xMin:-2,xMax:2,yMin:-2,yMax:2,iterations:32};
 assert.deepEqual([...referenceFractal(r).subarray(12)],[27,21,15,18,14,10,27,21,15,18,14,10]);
 const c=p.cases[0],parameters=JSON.parse(c.parameters);
 await assert.rejects(execute(c.input,{...parameters,regionKey:'0'.repeat(64)},c.config),/FRACTAL_INVALID/);
 const {workKeyV2}=require('@harmony/scheduler-core');
 assert.notEqual(workKeyV2(p.manifest.contract,c.parameters,c.input.length),workKeyV2(p.manifest.contract,JSON.stringify({...parameters,regionKey:'0'.repeat(64)}),c.input.length),'Different regions must not be interpreted as performance drift of one workload');
});
test('ArkTS reference kernel agrees with PC, validates scope and honors cancellation between rows',()=>{
 const source=fs.readFileSync(require('path').resolve(__dirname,'../../../apps/harmony/scheduler/src/main/ets/v2/host/executors/FractalKernel.ets'),'utf8').replace('@Concurrent','');
 const compiled=require('esbuild').transformSync(source,{loader:'ts',format:'cjs'}).code,m={exports:{}};let cancelled=false;
 new Function('require','module','exports',compiled)(()=>({taskpool:{Task:{isCanceled:()=>cancelled}}}),m,m.exports);
 const p=builtinCpuPacks().find(p=>p.manifest.packId==='render.fractal.v1');
 for(const c of p.cases.filter(c=>c.expect.kind==='OUTPUT'))assert.deepEqual(Buffer.from(m.exports.renderRegion(c.input.toString())),Buffer.from(c.expected,'base64'));
 assert.throws(()=>m.exports.renderRegion('{}'),/FRACTAL_INVALID/);cancelled=true;assert.throws(()=>m.exports.renderRegion(p.cases[0].input.toString()),/EXECUTION_CANCELLED/);
});
test('native renderer bridge validates region identity and waits for worker settlement after cancellation',async()=>{
 const path=require('path'),crypto=require('crypto');
 const source=fs.readFileSync(path.resolve(__dirname,'../../../apps/harmony/scheduler/src/main/ets/v2/host/executors/Fractal.ets'),'utf8');
 const compiled=require('esbuild').transformSync(source,{loader:'ts',format:'cjs'}).code,m={exports:{}};let rejectWorker,cancelled=false,cancelCalls=0,finished=false,calls=0;
 const native={render:async(_id,parameters)=>{calls++;assert.equal(parameters.length,11);return new Promise((_resolve,reject)=>{rejectWorker=reject;});},cancel:()=>{cancelCalls++;}};
 const platform={text:b=>Buffer.from(b).toString(),hash:b=>crypto.createHash('sha256').update(b).digest('hex'),factory:{id:crypto.randomUUID}};
 new Function('require','module','exports',compiled)(name=>name==='libharmony_render.so'?native:platform,m,m.exports);
 const p=builtinCpuPacks().find(p=>p.manifest.packId==='render.fractal.v1'),c=p.cases[0];
 const request={input:c.input,parameters:c.parameters,cancelled:()=>cancelled};
 await assert.rejects(m.exports.execute({...request,parameters:JSON.stringify({...JSON.parse(c.parameters),regionKey:'wrong'})}),/FRACTAL_INVALID/);assert.equal(calls,0);
 const pending=m.exports.execute(request);const observed=pending.then(()=>{finished=true;},()=>{finished=true;});cancelled=true;
 await new Promise(r=>setTimeout(r,120));assert.equal(cancelCalls,1);assert.equal(finished,false,'cancel request is not engine settlement');
 rejectWorker(Error('CANCELLED_SETTLED'));await assert.rejects(pending,/CANCELLED_SETTLED/);await observed;
});
