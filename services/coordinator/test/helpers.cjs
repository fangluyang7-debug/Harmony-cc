const fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {createCoordinator}=require('../dist/app');
const {loadConfig}=require('../dist/config');
async function runtime(options={}){
  fs.mkdirSync(path.resolve('../../.test'),{recursive:true});const dir=fs.mkdtempSync(path.resolve('../../.test/phase-b-'));
  const config=loadConfig({COORDINATOR_DATA_DIR:dir,COORDINATOR_PORT:'0',COORDINATOR_DOMAIN:'SIMULATED'});
  execFileSync(process.execPath,['scripts/migrate.cjs'],{env:{...process.env,COORDINATOR_DATA_DIR:dir},stdio:'pipe'});
  const result=await createCoordinator(config,async()=>{},options);await result.app.listen(0,'127.0.0.1');await result.restore();
  return Object.assign(result,{config,url:'https://localhost:'+result.app.getHttpServer().address().port});
}
module.exports={runtime};
