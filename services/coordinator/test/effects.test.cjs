const {test}=require('node:test'),assert=require('node:assert/strict');
const {SdkJobs}=require('../dist/sdk');
const {WorkflowJobs}=require('../dist/workflow-jobs');
const pack=policy=>({manifest:{contract:{capability:'commit',inputSchemas:['input'],outputSchemas:['output'],sideEffectPolicy:policy}}});
const body=()=>({workflow:{version:3,id:'wf',qualityTarget:'reference',outputContract:'output',nodes:[{id:'commit',capability:'commit',effects:'COMMIT',businessIdempotencyKey:'operation-1',parameters:'{}',dependsOn:[],input:{contentHash:'a'.repeat(64),bytes:1,schemaId:'input',schemaVersion:1}}]},options:{requestId:'job',budgetMs:1000,resultDestination:'ORIGIN'}});
test('commit requires a stable key and cannot masquerade as PURE',async()=>{
 let submitted;const sdk=new SdkJobs({submit:async(_peer,input)=>{submitted=input;return input;}},[pack('IDEMPOTENT_WRITE')]);
 await sdk.submit({},body());assert.equal(submitted.businessIdempotencyKey,'operation-1');
 const missing=body();delete missing.workflow.nodes[0].businessIdempotencyKey;await assert.rejects(sdk.submit({},missing),/SDK_IDEMPOTENCY_REQUIRED/);
 const forged=body();forged.workflow.nodes[0].effects='PURE';await assert.rejects(sdk.submit({},forged),/SDK_EFFECTS_MISMATCH/);
 const pure=new SdkJobs({},[pack('PURE')]);await assert.rejects(pure.submit({},body()),/SDK_EFFECTS_MISMATCH/);
});
test('COMMIT never enters automatic replacement even for an unstarted attempt',async()=>{
 let touched=false;const graphs=new WorkflowJobs({$transaction(){touched=true;throw Error('must not replace');}},null,null,null,[pack('IDEMPOTENT_WRITE')]);
 const result=await graphs.restartSettledOrUnstarted('wf',{deadlineAt:Date.now()+10000,workflow:{nodes:[{id:'commit',capability:'commit'}]}},{id:'commit',jobId:'original'});
 assert.equal(result,false);assert.equal(touched,false);
});
