const {test}=require('node:test'),assert=require('node:assert/strict'),{runtime}=require('./helpers.cjs');
test('coordinator uses WAL with durable commits and preserves committed state across reopen',async()=>{
 const r=await runtime();let reopened;
 try{
  assert.equal((await r.db.$queryRawUnsafe('PRAGMA journal_mode'))[0].journal_mode,'wal');
  assert.equal(Number((await r.db.$queryRawUnsafe('PRAGMA synchronous'))[0].synchronous),2);
  await r.db.device.create({data:{id:'committed-storage-fixture',groupId:'test',revision:1,metadataJson:'{}'}});
  await assert.rejects(r.db.$transaction(async tx=>{await tx.device.update({where:{id:'committed-storage-fixture'},data:{revision:2}});throw Error('ROLLBACK');}),/ROLLBACK/);
  await r.close();reopened=await require('../dist/app').createCoordinator(r.config);
  assert.equal((await reopened.db.device.findUnique({where:{id:'committed-storage-fixture'}})).revision,1);
  assert.equal((await reopened.db.$queryRawUnsafe('PRAGMA journal_mode'))[0].journal_mode,'wal');
 }finally{if(reopened)await reopened.close();else await r.close();}
});
