const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {PrismaClient}=require('../generated/client'),{serializeSqliteTransactions}=require('../dist/sqlite-transactions');
test('concurrent SQLite transactions commit once and a failed transaction does not stall the queue',{timeout:60000},async()=>{
 const file=path.join(os.tmpdir(),'harmony-photo-tx-'+crypto.randomUUID()+'.sqlite'),db=serializeSqliteTransactions(new PrismaClient({datasources:{db:{url:'file:'+file.replaceAll('\\','/')}}}));
 try{
  await db.$executeRawUnsafe('CREATE TABLE QueueProbe (value INTEGER UNIQUE)');
  let live=0,peak=0;
  await Promise.all(Array.from({length:32},(_,i)=>db.$transaction(async tx=>{live++;peak=Math.max(peak,live);try{await tx.$executeRawUnsafe('INSERT INTO QueueProbe (value) VALUES (?)',i);await tx.$queryRawUnsafe('SELECT COUNT(*) AS n FROM QueueProbe');}finally{live--;}})));
  assert.equal(peak,1);assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM QueueProbe'))[0].n),32);
  await assert.rejects(db.$transaction(async tx=>{await tx.$executeRawUnsafe('INSERT INTO QueueProbe (value) VALUES (99)');throw Error('ROLL_BACK');}),/ROLL_BACK/);
  await db.$transaction([db.$executeRawUnsafe('INSERT INTO QueueProbe (value) VALUES (100)')]);
  assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM QueueProbe'))[0].n),33);
  await assert.rejects(db.$transaction(()=>db.$transaction(()=>Promise.resolve())),/SQLITE_NESTED_TRANSACTION/);
  // Implicit transactions from standalone writes share the same writer queue.
  await Promise.all(Array.from({length:16},(_,i)=>Promise.all([
   db.$transaction(async tx=>{await tx.$executeRawUnsafe('INSERT INTO QueueProbe (value) VALUES (?)',200+i);await new Promise(r=>setTimeout(r,2));await tx.$queryRawUnsafe('SELECT COUNT(*) AS n FROM QueueProbe');}),
   db.$executeRawUnsafe('INSERT INTO QueueProbe (value) VALUES (?)',300+i)
  ])));
  assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM QueueProbe'))[0].n),65);
 }finally{await db.$disconnect();if(fs.existsSync(file))fs.unlinkSync(file);}
});
