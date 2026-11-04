const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite'),{transformSync}=require('esbuild');
test('Indexer keeps committed revisions across reopen and isolates the full model space',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-index-')),opened=[];
 try{
  const relationalStore={SecurityLevel:{S1:1},getRdbStore:async(_,config)=>{
   const db=new DatabaseSync(path.join(dir,config.name));opened.push(db);
   return {executeSql:async(sql,args=[])=>db.prepare(sql).run(...args),
    beginTransaction:()=>db.exec('BEGIN'),commit:()=>db.exec('COMMIT'),rollBack:()=>db.exec('ROLLBACK'),
    querySql:async(sql,args)=>{const statement=db.prepare(sql);statement.setReturnArrays(true);const data=statement.all(...args);let i=-1;
     return {goToFirstRow(){i=0;return !!data[0];},goToNextRow(){return !!data[++i];},getLong:n=>data[i][n],getString:n=>data[i][n],close(){}};}};
  }};
  const source=fs.readFileSync(path.resolve(__dirname,'../../apps/harmony-indexer/entry/src/main/ets/LocalImageIndex.ets'),'utf8');
  const native={exports:{}};
  new Function('module','require',transformSync(source,{loader:'ts',format:'cjs'}).code)(native,id=>{assert.equal(id,'@kit.ArkData');return {relationalStore};});
  const {LocalImageIndex}=native.exports,model={modelId:'fixture',version:'1',weightsHash:'a'.repeat(64),preprocessVersion:'rgb',embeddingKind:'image',dimension:2,dtype:'float32',normalization:'l2'};
  const store=await LocalImageIndex.open({});
  assert.equal(await store.append(model,[{hash:'red',vector:[1,0]},{hash:'blue',vector:[0,1]}]),1);
  assert.equal(await store.append(model,[{hash:'blue',vector:[0,1]}]),2);
  await assert.rejects(store.append(model,[{hash:'uncommitted',vector:[1,0]},{hash:null,vector:[1,0]}]));
  opened.pop().close();
  const reopened=await LocalImageIndex.open({});
  assert.deepEqual(await reopened.query(model,[0,1]),{revision:2,matches:[{hash:'blue',score:1},{hash:'red',score:0}]});
  assert.deepEqual(await reopened.query({...model,weightsHash:'b'.repeat(64)},[0,1]),{revision:0,matches:[]});
 }finally{for(const db of opened)db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
