const {test}=require('node:test'),assert=require('node:assert/strict'),sharp=require('sharp');
const {analyze,prepare,assemble}=require('../dist/executors/photo'),{encodeBundle,photoPacks,validateCoverage}=require('@harmony/reference-capabilities');
const configuration={id:'standard',threads:1,batchSize:1,quality:'standard'};

test('declared photo geometry cannot understate transfer bounds',async()=>{
 const {photoOutputBound}=require('@harmony/reference-capabilities');
 const png=await sharp({create:{width:72,height:16,channels:3,background:'#506080'}}).png().toBuffer();
 await assert.rejects(analyze(png,{width:1,height:1},configuration),/PHOTO_INVALID/);
 const source=(await analyze(png,{width:72,height:16},configuration)).output;
 assert.ok(source.length<=photoOutputBound('photo.analyze.v1',JSON.stringify({width:72,height:16}),8388608));
 assert.ok(photoOutputBound('photo.analyze.v1',JSON.stringify({width:72,height:16}),8388608)<8388608);
});
test('photo references cover every schema, with a real model fingerprint',()=>{const packs=photoPacks();assert.equal(packs.length,5);for(const p of packs)validateCoverage(p.manifest,p.cases);assert.match(packs[2].manifest.model.weightsHash,/^[a-f0-9]{64}$/);});
test('photo rejects corrupt inputs and illegal crop rectangles',async()=>{
 await assert.rejects(analyze(Buffer.from('{}'),{},configuration),/PHOTO_INVALID/);
 const png=await sharp({create:{width:4,height:3,channels:3,background:'#506080'}}).png().toBuffer(),source=(await analyze(png,{},configuration)).output;
 await assert.rejects(prepare(source,{x:3,y:0,width:2,height:3},configuration),/PHOTO_INVALID/);
 const altered=JSON.parse(source);altered.hash='0'.repeat(64);await assert.rejects(prepare(Buffer.from(JSON.stringify(altered)),{x:0,y:0,width:1,height:1},configuration),/PHOTO_INVALID/);
});
test('assembly refuses duplicate/missing tiles rather than presenting a partial image',async()=>{
 const {createHash}=require('node:crypto'),png=await sharp({create:{width:4,height:4,channels:3,background:'#204060'}}).png().toBuffer(),tile=Buffer.from(JSON.stringify({version:1,stage:'enhanced',width:2,height:1,rect:{x:0,y:0,width:1,height:1},scale:4,image:png.toString('base64'),hash:createHash('sha256').update(png).digest('hex')}));
 await assert.rejects(assemble(encodeBundle([{nodeId:'a',schemaId:'photo.tile',data:tile}]),{},configuration),/PHOTO_MISSING_TILE/);
 await assert.rejects(assemble(encodeBundle([{nodeId:'a',schemaId:'photo.tile',data:tile},{nodeId:'b',schemaId:'photo.tile',data:tile}]),{},configuration),/PHOTO_DUPLICATE_TILE/);
});
test('workflow stays within planner lookahead and comparison never mixes models, inputs or simulated evidence',async()=>{
 const {photoWorkflow,comparable}=await import('../../../apps/team-space-web/photo-workflow.mjs');
 for(const [w,h] of [[1,1],[72,16],[1024,1024],[1920,500]]){const g=photoWorkflow('run',{},w,h);assert.ok(g.workflow.nodes.length<=16);assert.equal(g.tiles.reduce((a,t)=>a+t.width*t.height,0),w*h);}
 const a={domain:'REAL',state:'SUCCEEDED',sourceDurationMs:1000,sourceDeviceId:'phone',budgetMs:180000,model:{weightsHash:'x'},scale:4,precision:'qualified-backend-default',inputs:[{hash:'image'}]};assert.equal(comparable(a,{...a,sourceDurationMs:500}),true);
 for(const change of [{domain:'SIMULATED'},{model:{weightsHash:'y'}},{inputs:[{hash:'another'}]},{budgetMs:300000},{sourceDeviceId:'pc'},{state:'FAILED'}])assert.equal(comparable(a,{...a,...change}),false);
});
