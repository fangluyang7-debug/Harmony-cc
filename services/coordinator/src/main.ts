import { createCoordinator } from './app';
import { loadConfig } from './config';
async function main(){
  const config=loadConfig(process.env),runtime=await createCoordinator(config,async()=>{},{cpuHost:process.env.COORDINATOR_CPU_HOST==='1'});
  try{await runtime.app.listen(config.port,config.host);await runtime.restore();}
  catch(error){await runtime.close();throw error;}
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void runtime.close().then(()=>process.exit(0));});
  console.log('Coordinator ready');
}
void main().catch(()=>{console.error('COORDINATOR_START_FAILED');process.exitCode=1;});
