import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { createCoordinator } from './app';
import { loadConfig } from './config';
import { builtinCpuPacks,builtinReferencePacks,loadImageEncodingPack,loadServicePacks } from '@harmony/reference-capabilities';
import {advertiseCoordinator} from './discovery';
let stopRequested=false,shutdown:(()=>void)|null=null;
process.on('message',(message:any)=>{if(message?.type==='shutdown'){stopRequested=true;shutdown?.();}});
async function main(){
  const config=loadConfig(process.env),cpuHost=process.env.COORDINATOR_CPU_HOST==='1';
  const suite=process.env.COORDINATOR_IMAGE_ENCODING_SUITE;
  if(suite&&!cpuHost)throw Error('ENCODING_ARTIFACT_HOST_REQUIRED');
  // Service-provided capabilities (e.g. a catalogue vector search) are ordinary packs: the same
  // declaration file is installed on the coordinator and on the service host so suite digests match.
  const servicePacks=process.env.COORDINATOR_SERVICE_PACKS;
  const referencePacks=suite||servicePacks?[...(cpuHost?await builtinReferencePacks():builtinCpuPacks()),...(suite?[await loadImageEncodingPack(suite)]:[]),...(servicePacks?await loadServicePacks(servicePacks):[])]:undefined;
  const runtime=await createCoordinator(config,async()=>{},{cpuHost,referencePacks,onError:error=>{
    // Preserve actionable database/transport codes without logging credentials,
    // request bodies or Prisma query arguments into the desktop console.
    const e=error as {code?:unknown;name?:unknown;message?:unknown};
    const code=typeof e?.code==='string'&&/^[A-Z0-9_]{1,100}$/.test(e.code)?e.code:
      typeof e?.message==='string'&&/^[A-Z0-9_]{1,100}$/.test(e.message)?e.message:'OPERATION_FAILED';
    console.error('COORDINATOR_OPERATION_FAILED '+code);
  }});
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
