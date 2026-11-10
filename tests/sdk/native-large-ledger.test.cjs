const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../../apps/harmony/scheduler/src/main/ets/v2/host/NativePlatform.ets'),'utf8');
function database(port){const start=source.indexOf('export class NativeDatabase'),end=source.indexOf('\nclass NativeLedgerPersistence',start),module={exports:{}};const code=require('esbuild').transformSync(source.slice(start,end).replace('export class','class')+'\nmodule.exports=NativeDatabase;',{loader:'ts',format:'cjs'}).code;new Function('module',code)(module);return new module.exports(port);}
function row(value,present=true){return {rowCount:present?1:0,goToFirstRow:()=>present,getLong:()=>value,getString:()=>value,close(){}};}
test('native database reads a > 2 MiB Unicode ledger completely and serializes writes across chunk reads',async()=>{
 const original='A'.repeat(2200000)+'鞋🙂'.repeat(70000),points=Array.from(original);let stored=original,writes=0,release,first=true;
 const gate=new Promise(resolve=>release=resolve),port={querySql:async(sql,args)=>{
  if(sql.includes('length(value)'))return row(points.length);
  assert.match(sql,/substr\(value/);if(first){first=false;await gate;}
  const part=points.slice(args[0]-1,args[0]-1+131072).join('');assert.ok(Buffer.byteLength(part)<2097152);return row(part);
 },executeSql:async(_sql,args)=>{stored=args[1];writes++;}};
 const db=database(port),reading=db.get('ledger'),writing=db.put('ledger','new state');await new Promise(resolve=>setImmediate(resolve));assert.equal(writes,0);release();assert.equal(await reading,original);await writing;assert.equal(stored,'new state');assert.equal(writes,1);
});
test('an unreadable existing native ledger is an error, never an absent installation',async()=>{
 let writes=0;const db=database({querySql:async()=>({...row(1),goToFirstRow:()=>false}),executeSql:async()=>writes++});
 await assert.rejects(db.get('ledger'),/DATABASE_CURSOR_UNAVAILABLE/);assert.equal(writes,0);
 const absent=database({querySql:async()=>row(0,false)});assert.equal(await absent.get('missing'),null);
 const empty=database({querySql:async()=>row(0)});assert.equal(await empty.get('empty'),'');
});
