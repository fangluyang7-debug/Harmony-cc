import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import Ajv from 'ajv';
const root=new URL('../',import.meta.url),base=new URL('contracts/scheduling/v2/',root);
const load=p=>JSON.parse(fs.readFileSync(new URL(p,base),'utf8'));
const ajv=new Ajv({allErrors:true});ajv.addSchema(load('schema/protocol.schema.json'));ajv.addSchema(load('schema/resources.schema.json'));
function module(source,dependencies={}){const exports={};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:name=>{if(!dependencies[name])throw Error('UNEXPECTED_IMPORT');return dependencies[name];}});return exports;}
const t1=module(fs.readFileSync(new URL('packages/scheduler-core/src/protocol-v2.ts',root),'utf8'));
const sources=['packages/scheduler-core/src/resources-v2.ts','apps/harmony/scheduler/src/main/ets/v2/protocol/ResourcesV2.ets'].map(p=>fs.readFileSync(new URL(p,root),'utf8').replace(/\r\n/g,'\n').replace("'./SchedulingProtocolV2'","'./protocol-v2'"));
assert.equal(sources[0],sources[1]);let cases=0;
for(const source of sources){
 const api=module(source,{'./protocol-v2':t1});
 for(const file of fs.readdirSync(new URL('fixtures/t2/valid/',base))){
  const name=file.replace('.json',''),validate=api['valid'+name+'V2'],schema=ajv.getSchema('urn:scheduling:v2:resources#/definitions/'+name);
  assert.equal(typeof validate,'function',name);
  const value=load('fixtures/t2/valid/'+file);assert.equal(schema(value),true,name+JSON.stringify(schema.errors));assert.equal(validate(value),true,name);cases++;
  for(const suffix of ['missing','unknown']){const bad=load(`fixtures/t2/invalid/${name}-${suffix}.json`);assert.equal(schema(bad),false,name);assert.equal(validate(bad),false,name);cases++;}
  for(const bad of [null,undefined,0,[],true]){assert.equal(validate(bad),false,name);cases++;}
 }
 const admission=load('fixtures/t2/valid/CapabilityAdmission.json');
 const schema=ajv.getSchema('urn:scheduling:v2:resources#/definitions/CapabilityAdmission');
 for(const patch of [{state:'ADMIN_APPROVED'},{revision:0},{identity:'not-a-hash'},
   {quality:{...admission.quality,value:2}},{quality:{...admission.quality,value:null,source:'UNKNOWN'}},
   {quality:{...admission.quality,source:'PRIOR'}},{quality:{...admission.quality,source:'UNKNOWN'}},{domain:'REAL'}]){
  const bad={...admission,...patch};assert.equal(schema(bad),false,JSON.stringify(patch));assert.equal(api.validCapabilityAdmissionV2(bad),false);cases++;
 }
}
console.log(`PASS T2 TS/ArkTS schemas and parity: ${cases} fixture/invalid-input checks (not native HAR compilation)`);
