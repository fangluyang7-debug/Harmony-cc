import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { createCoordinator } from './app';
import { loadConfig } from './config';
import { builtinReferencePacks,loadImageEncodingPack } from '@harmony/reference-capabilities';
import {advertiseCoordinator} from './discovery';
let stopRequested=false,shutdown:(()=>void)|null=null;
process.on('message',(message:any)=>{if(message?.type==='shutdown'){stopRequested=true;shutdown?.();}});
async function main(){
  const config=loadConfig(process.env),cpuHost=process.env.COORDINATOR_CPU_HOST==='1';
  const suite=process.env.COORDINATOR_IMAGE_ENCODING_SUITE;
  if(suite&&!cpuHost)throw Error('ENCODING_ARTIFACT_HOST_REQUIRED');
  const referencePacks=suite?[...await builtinReferencePacks(),await loadImageEncodingPack(suite)]:undefined;
  const runtime=await createCoordinator(config,async()=>{},{cpuHost,referencePacks});
  try{await runtime.app.listen(config.port,config.host);await runtime.restore();}
  catch(error){await runtime.close();throw error;}
  const stopDiscovery=!config.proxy&&config.publicUrl?advertiseCoordinator(config.publicUrl,()=>console.error('DISCOVERY_UNAVAILABLE: use QR invitation')):()=>{};
  let closing=false;const close=()=>{if(closing)return;closing=true;stopDiscovery();void runtime.close().then(()=>process.exit(0));};
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,close);
  shutdown=close;if(stopRequested){close();return;}
  if(!config.proxy){const certificateFile=path.join(config.dataDir,'coordinator-public.crt');fs.writeFileSync(certificateFile,runtime.identity.cert);console.log('Public certificate: '+certificateFile+'\nSHA-256: '+new X509Certificate(runtime.identity.cert).fingerprint256);}
  console.log('Coordinator ready: '+(config.publicUrl??'(no public URL configured)'));
}
void main().catch(error=>{const code=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:(error as NodeJS.ErrnoException)?.code;console.error('COORDINATOR_START_FAILED '+(typeof code==='string'&&/^[A-Z0-9_]+$/.test(code)?code:'CHECK_CONFIGURATION'));process.exitCode=1;if(process.connected)process.disconnect();});
