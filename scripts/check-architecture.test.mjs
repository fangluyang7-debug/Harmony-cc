import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectSource, checkArchitecture } from './check-architecture.mjs';
const fixtures=JSON.parse(fs.readFileSync(new URL('./fixtures/architecture.json',import.meta.url),'utf8'));
for(const f of fixtures)test(f.name,()=>assert.equal(inspectSource(f.source,'fixture.ts',f.core).errors.length===0,f.valid));
test('production tree passes and CLI exits successfully',()=>{
  assert.deepEqual(checkArchitecture().errors,[]);
  assert.equal(spawnSync(process.execPath,['scripts/check-architecture.mjs']).status,0);
});
test('real CLI rejects a relative v1 service import and core escape',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'architecture-fixture-'));
  try {
    const targets=[['services/coordinator/src/index.ts',"import x from '../../api-server/src/core/runtime/device-dispatch.service';"],['packages/scheduler-core/src/index.ts',"export * from '../../../other/leaf';"]];
    for(const [name,source] of targets){const file=path.join(dir,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,source);}
    const result=spawnSync(process.execPath,['scripts/check-architecture.mjs',dir],{encoding:'utf8'});
    assert.equal(result.status,1);assert.match(result.stderr,/V1_DEPENDENCY/);assert.match(result.stderr,/CORE_ESCAPING_DEPENDENCY/);
  } finally {if(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'architecture-fixture-'))fs.rmSync(dir,{recursive:true,force:true});}
});
test('a service cannot hide a v1 dependency behind another workspace package',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'architecture-fixture-'));
  try{
    const sources={
      'packages/scheduler-core/src/index.ts':'export const value=1;',
      'services/coordinator/src/index.ts':"export * from '../../../packages/bridge/src';",
      'packages/bridge/src/index.ts':"export * from '../../../services/api-server/src/legacy';",
      'services/api-server/src/legacy.ts':'export const value=2;'
    };
    for(const [name,source] of Object.entries(sources)){const file=path.join(dir,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,source);}
    assert.ok(checkArchitecture(dir).errors.some(e=>e.includes('TRANSITIVE_V1_DEPENDENCY')));
  }finally{if(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'architecture-fixture-'))fs.rmSync(dir,{recursive:true,force:true});}
});
