const {PrismaClient}=require('../generated/client');
const {CoordinatorStore}=require('../dist/store');
const {attempt}=require('./fixtures.cjs');
(async()=>{
  const db=new PrismaClient({datasources:{db:{url:process.argv[2]}}}),store=new CoordinatorStore(db,'coordinator1'),f=attempt();
  await store.persistOffer(f.offer,f.record.holderInstanceId,f.message);
  if(process.argv[3]==='after-send')await store.flush(async()=>{});
  process.exit(17); // Abrupt exit: no disconnect, no ACK, no cleanup hook.
})().catch(()=>process.exit(18));
