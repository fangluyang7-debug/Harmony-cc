const {test}=require('node:test'),assert=require('node:assert/strict');
const {cropEvaluationPack}=require('../dist/crop-evaluation-pack'),{executeCpu}=require('../dist/cpu-engine');
const manifest=require('../../../capabilities/image.crop.v1/manifest.json');
test('trusted image crop suite checks independent left/right references and rejects wrong geometry or color',async()=>{
 const pack=await cropEvaluationPack(manifest);const outputs=[];
 for(const item of pack.cases){const result=await executeCpu(manifest.contract.capability,item.input,JSON.parse(item.parameters),item.config,new AbortController().signal);outputs.push(result.bytes);assert.ok(await pack.evaluate(item,result.bytes)>=manifest.qualityThreshold);}
 assert.equal(await pack.evaluate(pack.cases[0],outputs[1]),0);
 assert.equal(await pack.evaluate(pack.cases[1],outputs[0]),0);
 await assert.rejects(pack.evaluate(pack.cases[0],Buffer.from('invalid')));
});
