const {execFileSync}=require('node:child_process');
const path=require('node:path');
const {mkdirSync}=require('node:fs');
const {loadConfig,databaseUrl}=require('../dist/config');
const config=loadConfig(process.env),data=config.dataDir;
mkdirSync(data,{recursive:true});
const url=databaseUrl(config);
async function migrate(){
  // Prisma 6's Windows schema engine needs an existing SQLite file on this host.
  const {PrismaClient}=require('../generated/client');
  const db=new PrismaClient({datasources:{db:{url}}});
  try{await db.$connect();}finally{await db.$disconnect();}
  execFileSync(process.execPath,[require.resolve('prisma/build/index.js'),'migrate','deploy','--schema',path.join(__dirname,'../prisma/schema.prisma')],{
    cwd:path.join(__dirname,'..'),env:{...process.env,COORDINATOR_DATABASE_URL:url},stdio:'inherit'
  });
}
void migrate().catch(()=>{console.error('COORDINATOR_MIGRATION_FAILED');process.exitCode=1;});
