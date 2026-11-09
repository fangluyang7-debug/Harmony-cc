const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {validDeclaration}=require('../dist/app-declaration');
// The shopping App ships its complete AI declaration as a raw resource; the coordinator must accept exactly that file.
const file=path.resolve(__dirname,'../../../apps/harmony/entry/src/main/resources/rawfile/ai-declaration.json');

test('the shipped App declaration covers every AI workflow and validates against the coordinator rules',()=>{
 const manifest=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.equal(validDeclaration(manifest.declaration,manifest.allowedContracts),true);
 const ids=manifest.declaration.workflows.map(w=>w.id).sort();
 assert.deepEqual(ids,['shopping.image','shopping.more','shopping.profile','shopping.refine','shopping.suggestions','shopping.text']);
 const nodesOf=w=>w.nodes??w.alternatives.flatMap(a=>a.nodes);
 for(const w of manifest.declaration.workflows){
  assert.equal(w.qualityTarget,'reference',w.id);
  const nodes=nodesOf(w),commits=nodes.filter(n=>n.effects==='COMMIT');
  // Every workflow that writes business state names exactly one explicit commit step per path; nothing else is a write.
  for(const n of nodes)assert.ok(['PURE','COMMIT'].includes(n.effects),w.id+'/'+n.id);
  if(w.id!=='shopping.suggestions')assert.ok(commits.length>=1&&commits.every(n=>n.capability==='shopping.commit.v1'&&n.privacy==='OWNER_SERVICE'),w.id);
  else assert.equal(commits.length,0);
  // Raw user text never leaves the App's own service; product imagery nodes stay shareable so the planner can place them.
  for(const n of nodes){if(['chat.understand.v1','chat.suggest.v1'].includes(n.capability))assert.equal(n.privacy,'OWNER_SERVICE',w.id+'/'+n.id);if(['image.crop.v1','image.encode.v1'].includes(n.capability))assert.equal(n.privacy,undefined,w.id+'/'+n.id);}
 }
 // Placement is never declared: no node pins a target, a host or a "fixed" marker.
 const text=fs.readFileSync(file,'utf8');
 for(const forbidden of ['targetId','deviceId','fixed','placement'])assert.equal(text.includes(forbidden),false,forbidden);
 // Equivalent image paths differ only in structure (encode-then-search vs service-side image search); who runs each node is the planner's call.
 const image=manifest.declaration.workflows.find(w=>w.id==='shopping.image');
 assert.deepEqual(image.alternatives.map(a=>a.id),['shopping.image.encode-then-search','shopping.image.service-search']);
 assert.ok(image.alternatives.every(a=>a.inputSchema===image.inputSchema&&a.outputContract===image.outputContract));
});
