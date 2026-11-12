const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{transformSync}=require('esbuild');
function load(){const code=transformSync(fs.readFileSync('apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorDatabase.ets','utf8'),{loader:'ts',format:'cjs'}).code,m={exports:{}};new Function('require','module','exports',code)(()=>({}),m,m.exports);return m.exports.CoordinatorDatabase;}
test('native coordinator serializes transactions and recovers its queue after rollback',async()=>{
 const calls=[],db=new (load())({createTransaction:async()=>{calls.push('begin');return {commit:async()=>calls.push('commit'),rollback:async()=>calls.push('rollback')};}});
 let release;const gate=new Promise(r=>release=r);
 const a=db.transaction(async()=>{calls.push('a');await gate;throw Error('FAILED');});
 const b=db.transaction(async()=>{calls.push('b');});
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,['begin','a']);release();await assert.rejects(a,/FAILED/);await b;
 assert.deepEqual(calls,['begin','a','rollback','begin','b','commit']);
});
