import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectSource, checkArchitecture } from './check-architecture.mjs';
const fixtures=JSON.parse(fs.readFileSync(new URL('./fixtures/architecture.json',import.meta.url),'utf8'));
for(const f of fixtures)test(f.name,()=>assert.equal(inspectSource(f.source,'fixture.ts',f.core).errors.length===0,f.valid));

test('R21 rejects candidate access, aliases and destructuring outside registered planning/read-only modules',()=>{
  for(const source of ['snapshot.candidates.filter(c=>c.trusted);', 'const rows = view["candidates"]; rows.sort(compare);', 'const {candidates: rows}=snapshot;']){
    assert.ok(inspectSource(source,'services/coordinator/src/bypass.ts',false).errors.some(e=>e.includes('DISPATCH_OUTSIDE_PLANNING')));
    assert.deepEqual(inspectSource(source,'services/coordinator/src/planning.ts',false).errors,[]);
    assert.deepEqual(inspectSource(source,'services/coordinator/src/spaces.ts',false).errors,[]);
  }
});
test('R25 rejects literal identities in coordinator and SDK but accepts credential-derived identities',()=>{
  for(const file of ['services/coordinator/src/new-entry.ts','apps/harmony/scheduler/src/main/ets/v2/client/submit.ets']){
    for(const source of ['const app={appId:"fixed"};','offer.appId="fixed";','peer["deviceId"]="fixed";','const p={principalId:`fixed`};','const appId="fixed";','class App { deviceId="fixed"; }'])assert.ok(inspectSource(source,file,false).errors.some(e=>e.includes('HARDCODED_CREDENTIAL_IDENTITY')));
    assert.deepEqual(inspectSource('const app={appId:credential.appId,principalId:peer.principalId,deviceId:peer.deviceId};',file,false).errors,[]);
  }
});

test('CLI rejects R21/R25 violation fixtures in a production-shaped tree',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'architecture-fixture-'));
  try{
    for(const [name,source] of Object.entries({'packages/scheduler-core/src/index.ts':'export const value=1;',
      'services/coordinator/src/bypass.ts':'const chosen=snapshot.candidates[0]; const app={appId:"fixed"};'})){
      const file=path.join(dir,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,source);
    }
    const result=spawnSync(process.execPath,['scripts/check-architecture.mjs',dir],{encoding:'utf8'});
    assert.equal(result.status,1);assert.match(result.stderr,/DISPATCH_OUTSIDE_PLANNING/);assert.match(result.stderr,/HARDCODED_CREDENTIAL_IDENTITY/);
  }finally{if(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'architecture-fixture-'))fs.rmSync(dir,{recursive:true,force:true});}
});
test('production tree passes and CLI exits successfully',()=>{
  assert.deepEqual(checkArchitecture().errors,[]);
  assert.equal(spawnSync(process.execPath,['scripts/check-architecture.mjs']).status,0);
});
test('ArkTS pure core rejects Kit IO and ambient clocks',()=>{
  for(const source of ["import {http} from '@kit.NetworkKit';",'const now=Date.now();',"import fs from 'node:fs';"])
    assert.ok(inspectSource(source,'apps/harmony/scheduler/src/main/ets/v2/core/Bad.ets',true).errors.length);
});
test('ArkTS dependency scanner resolves ets and forbids client-to-agent/core-to-agent imports',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'architecture-fixture-'));
 try{
  for(const [file,source]of Object.entries({'apps/harmony/scheduler/src/main/ets/v2/client/Bad.ets':"export * from '../agent/Target';",'apps/harmony/scheduler/src/main/ets/v2/agent/Target.ets':'export const target=1;','apps/harmony/scheduler/src/main/ets/v2/core/Bad.ets':"export * from '../agent/Target';"})){const p=path.join(dir,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,source);}
  const errors=checkArchitecture(dir).errors;assert.ok(errors.some(e=>e.includes('CLIENT_AGENT_DEPENDENCY')));assert.ok(errors.some(e=>e.includes('CORE_ESCAPING_DEPENDENCY')));
 }finally{const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'architecture-fixture-'));fs.rmSync(resolved,{recursive:true,force:true});}
});
test('ArkTS client and agent cannot hide a dependency through a shared ets bridge',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'architecture-fixture-'));
 try{
  for(const [file,source]of Object.entries({'client/Start.ets':"export * from '../Bridge';",'Bridge.ets':"export * from './agent/Target';",'agent/Target.ets':'export const target=1;'})){const p=path.join(dir,'apps/harmony/scheduler/src/main/ets/v2',file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,source);}
  assert.ok(checkArchitecture(dir).errors.some(e=>e.includes('CLIENT_AGENT_DEPENDENCY')));
 }finally{const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'architecture-fixture-'));fs.rmSync(resolved,{recursive:true,force:true});}
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
