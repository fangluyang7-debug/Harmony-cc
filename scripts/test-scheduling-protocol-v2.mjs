import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import Ajv from 'ajv';
let checks=0;
const equal=(...args)=>{assert.equal(...args);checks++;};
const base=new URL('../contracts/scheduling/v2/',import.meta.url);
const paths=['../packages/scheduler-core/src/protocol-v2.ts','../apps/harmony/scheduler/src/main/ets/v2/protocol/SchedulingProtocolV2.ets'];
const sources=paths.map(p=>fs.readFileSync(new URL(p,import.meta.url),'utf8').replace(/\r\n/g,'\n'));
equal(sources[0],sources[1],'T1 TS/ArkTS drift');
const schema=JSON.parse(fs.readFileSync(new URL('schema/protocol.schema.json',base),'utf8'));
const ajv=new Ajv({allErrors:true,strictNumbers:true});ajv.addSchema(schema);
for(const source of sources){
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
  const api={};vm.runInNewContext(code,{exports:api});
  for(const file of fs.readdirSync(new URL('fixtures/valid/',base))){
    const name=file.replace('.json',''),validate=api[`valid${name}V2`];equal(typeof validate,'function',name);
    const structural=ajv.getSchema(`urn:scheduling:v2#/definitions/${name}`);
    const fixture=JSON.parse(fs.readFileSync(new URL('fixtures/valid/'+file,base),'utf8'));
    equal(structural(fixture),true,`${name} schema: ${JSON.stringify(structural.errors)}`);
    equal(validate(fixture,[]),true,`${name} valid`);
    for(const suffix of ['missing','unknown']){
      const invalid=JSON.parse(fs.readFileSync(new URL(`fixtures/invalid/${name}-${suffix}.json`,base),'utf8'));
      equal(structural(invalid),false,`${name} schema rejects ${suffix}`);
      equal(validate(invalid,[]),false,`${name} rejects ${suffix}`);
    }
    for(const invalid of [null,[],0,'invalid',undefined]){equal(validate(invalid,[]),false,name);}
  }
  const load=name=>JSON.parse(fs.readFileSync(new URL(`fixtures/valid/${name}.json`,base),'utf8'));
  const hello=load('VersionHello');equal(api.negotiateVersionV2(hello,hello),2);
  equal(api.negotiateVersionV2(hello,{versions:[1],extensions:[]}),null);
  const extension=load('Extension');extension.required=true;
  equal(api.negotiateVersionV2(hello,{versions:[2],extensions:[extension]}),null);
  extension.required=false;equal(api.negotiateVersionV2(hello,{versions:[2],extensions:[extension]}),2);
  const envelope=load('MessageEnvelope');envelope.extensions=[{...extension,required:true}];equal(api.validMessageEnvelopeV2(envelope,[]),false);
  equal(api.validMessageEnvelopeV2(envelope,[extension]),true);
  const alt=load('Alternatives');alt.alternatives[0].qualityTarget='different';equal(api.validAlternativesV2(alt),false);
  alt.alternatives=[null];equal(api.validAlternativesV2(alt),false);
  const wf=load('Workflow');wf.nodes[0].dependsOn=['node1'];equal(api.validWorkflowV2(wf),false);
  const task=load('TaskInstance');task.app.groupId='another-group';equal(api.validTaskInstanceV2(task),false);
  const record=load('AttemptRecord'),receipt=load('ExecutionReceipt');
  equal(api.mayCommitReceiptV2(record,receipt,1,1),true);
  equal(api.mayCommitReceiptV2(record,receipt,2,1),false);
  equal(api.mayCommitReceiptV2(record,receipt,1,2),false);
  receipt.fence.holderInstanceId='other-holder';equal(api.mayCommitReceiptV2(record,receipt,1,1),false);
  const grant=load('ArtifactGrant'),caller=load('AppIdentity');
  equal(api.allowsArtifactV2(grant,caller,'READ',1),true);
  equal(api.allowsArtifactV2(grant,caller,'READ',1000),false);
  caller.appInstanceId='other-app';equal(api.allowsArtifactV2(grant,caller,'READ',1),false);
  const span=load('TraceSpan');span.durationMs=9;equal(api.validTraceSpanV2(span),false);
  span.durationMs=10;span.phase='TRANSFER_SEND';equal(api.validTraceSpanV2(span),false);
}
console.log(`PASS T1 schemas and TS/ArkTS parity: ${checks} assertions (transpiled fixture tests, not native HAR compilation)`);
