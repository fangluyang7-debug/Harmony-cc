const path=require('node:path'),os=require('node:os'),fs=require('node:fs');
const {spawnSync,spawn}=require('node:child_process');
const {isIP}=require('node:net');
function lanEnvironment(address,port='7443',dataDir,base=process.env){
  const addresses=Object.values(os.networkInterfaces()).flat().filter(Boolean).filter(i=>!i.internal).map(i=>i.address);
  if(isIP(address)!==4||!addresses.includes(address))throw Error('LAN_ADDRESS_REQUIRED: choose a local interface IPv4: '+addresses.filter(a=>isIP(a)===4).join(', '));
  if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535)throw Error('LAN_PORT_INVALID');
  return {...base,COORDINATOR_HOST:'0.0.0.0',COORDINATOR_PORT:port,COORDINATOR_CERTIFICATE_HOST:address,
    COORDINATOR_PUBLIC_URL:`https://${address}:${port}`,COORDINATOR_TLS_MODE:'pinned',COORDINATOR_CPU_HOST:'1',COORDINATOR_DOMAIN:'REAL',
    COORDINATOR_DATA_DIR:path.resolve(dataDir??'services/coordinator/data/lan'),COORDINATOR_WEB_DIR:path.resolve('apps/team-space-web')};
}
function main(){
  const env=lanEnvironment(...process.argv.slice(2));
  if(!fs.existsSync('services/coordinator/dist/main.js'))throw Error('Run npm --workspace @harmony/coordinator run build first');
  const migration=spawnSync(process.execPath,['scripts/migrate.cjs'],{cwd:'services/coordinator',env,stdio:'inherit',windowsHide:true});
  if(migration.error)throw migration.error;if(migration.status!==0)throw Error('LAN_MIGRATION_FAILED');
  console.log('Coordinator URL: '+env.COORDINATOR_PUBLIC_URL+'\nData directory: '+env.COORDINATOR_DATA_DIR);
  const child=spawn(process.execPath,['services/coordinator/dist/main.js'],{env,stdio:'inherit',windowsHide:true});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
  child.on('error',error=>{console.error(error.message);process.exitCode=1;});
  child.on('exit',code=>{process.exitCode=code??1;});
}
module.exports={lanEnvironment};
if(require.main===module)try{main();}catch(error){console.error(error.message);process.exitCode=1;}
