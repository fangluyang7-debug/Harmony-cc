import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { createCoordinator } from './app';
import { loadConfig } from './config';
async function main(){
  const config=loadConfig(process.env),runtime=await createCoordinator(config,async()=>{},{cpuHost:process.env.COORDINATOR_CPU_HOST==='1'});
  try{await runtime.app.listen(config.port,config.host);await runtime.restore();}
  catch(error){await runtime.close();throw error;}
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void runtime.close().then(()=>process.exit(0));});
  if(!config.proxy){const certificateFile=path.join(config.dataDir,'coordinator-public.crt');fs.writeFileSync(certificateFile,runtime.identity.cert);console.log('Public certificate: '+certificateFile+'\nSHA-256: '+new X509Certificate(runtime.identity.cert).fingerprint256);}
  console.log('Coordinator ready: '+(config.publicUrl??'(no public URL configured)'));
}
void main().catch(error=>{console.error('COORDINATOR_START_FAILED '+(error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:''));process.exitCode=1;});
