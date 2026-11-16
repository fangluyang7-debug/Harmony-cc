const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{transformSync}=require('esbuild');
function observer(){const m={exports:{}};new Function('module','exports',transformSync(fs.readFileSync('apps/harmony/scheduler/src/main/ets/v2/host/NativeWorkSlots.ets','utf8'),{loader:'ts',format:'cjs'}).code)(m,m.exports);let now=100;return {slots:new m.exports.NativeWorkSlots(()=>now),advance:n=>now+=n};}
const offer=id=>({task:{attemptId:id,workflowId:'workflow',nodeId:'filter',contract:{capability:'catalog.filter.v1'},originDeviceId:'phone'},target:{backend:'CPU'}});
test('real stage changes and terminal evidence survive sub-frame tasks without fabricated progress',()=>{
 const {slots,advance}=observer();assert.deepEqual(JSON.parse(slots.snapshot()),[]);
 slots.begin(offer('a'));slots.stage('a','EXECUTE',123);advance(8);slots.stage('a','PUBLISH',45);slots.finish('a','SUCCEEDED');
 advance(1000);slots.begin(offer('a'));slots.stage('a','LOAD');slots.finish('a','FAILED');
 const [row]=JSON.parse(slots.snapshot());assert.equal(row.state,'SUCCEEDED');assert.equal(row.step,5);assert.equal(row.elapsedMs,8);assert.equal(row.inputBytes,123);assert.equal(row.outputBytes,45);
});
test('parallel work stays separate, rejection is not success, calibration without dispatch is ignored',()=>{
 const {slots}=observer();slots.stage('calibration','EXECUTE');slots.finish('calibration','SUCCEEDED');assert.equal(JSON.parse(slots.snapshot()).length,0);
 slots.begin(offer('a'));slots.begin(offer('b'));slots.stage('a','EXECUTE');slots.stage('b','QUEUE');slots.finish('b','REJECTED','OWNER_ACTIVE');
 const rows=JSON.parse(slots.snapshot());assert.equal(rows[0].state,'RUNNING');assert.equal(rows[1].step,1);assert.equal(rows[1].error,'OWNER_ACTIVE');
});
test('history is bounded and does not discard observed running work to admit display records',()=>{
 const {slots}=observer();slots.begin(offer('active'));for(let i=0;i<100;i++){slots.begin(offer('done-'+i));slots.finish('done-'+i,'SUCCEEDED');}
 const rows=JSON.parse(slots.snapshot());assert.equal(rows.length,32);assert.equal(rows[0].id,'active');assert.equal(rows.at(-1).id,'done-99');
 const b=observer().slots;for(let i=0;i<40;i++)b.begin(offer('active-'+i));assert.equal(JSON.parse(b.snapshot()).length,32);
});
