import fs from 'node:fs';
import path from 'node:path';
import {loadServiceDeclaration,vectorSearchPack,stagePacks,commitPack,commitCapability} from '@harmony/reference-capabilities';
import {CpuHost,CpuHostConfig,ServiceAdapter} from './host';
import {ServiceConnection,vectorSearchAdapter,verifyVectorSearchSpace,stageAdapter,commitAdapter} from './service-adapters';

/**
 * Standalone host for a business service's own capabilities.
 * Usage: service-host-main.js <agent.json> <contribution.json> <service.json>
 * service.json: {"packs":"<absolute path of the shared service pack declaration>","baseUrl":"https://service/","tokenEnv":"SERVICE_TOKEN","routes":{...optional}}
 * The service credential is read from the named environment variable and never persisted or logged.
 */
interface ServiceFile {packs:string;baseUrl:string;tokenEnv:string;routes?:Record<string,string>;timeoutMs?:number;}
let stopRequested=false,shutdown:(()=>Promise<void>)|null=null;
process.on('message',(message:any)=>{if(message==='stop'||message?.type==='shutdown'){stopRequested=true;if(shutdown)void shutdown().then(()=>process.disconnect?.());}});
function validServiceFile(value:unknown):value is ServiceFile {
  const v=value as ServiceFile;
  return !!v&&typeof v==='object'&&Object.keys(v).every(k=>['packs','baseUrl','tokenEnv','routes','timeoutMs'].includes(k))&&typeof v.packs==='string'&&path.isAbsolute(v.packs)&&
    typeof v.baseUrl==='string'&&typeof v.tokenEnv==='string'&&/^[A-Z][A-Z0-9_]{2,63}$/.test(v.tokenEnv)&&
    (v.routes===undefined||!!v.routes&&typeof v.routes==='object'&&Object.values(v.routes).every(r=>typeof r==='string'&&r.startsWith('/')))&&
    (v.timeoutMs===undefined||Number.isSafeInteger(v.timeoutMs)&&v.timeoutMs>=1000&&v.timeoutMs<=120000);
}
async function main(){
  const [pairedFile,contributionFile,serviceFile]=process.argv.slice(2);if(!pairedFile||!contributionFile||!serviceFile)throw Error('SERVICE_HOST_ARGUMENTS');
  const service=JSON.parse(fs.readFileSync(serviceFile,'utf8'));if(!validServiceFile(service))throw Error('SERVICE_FILE_INVALID');
  const token=process.env[service.tokenEnv];if(typeof token!=='string'||!token.length)throw Error('SERVICE_TOKEN_MISSING');
  const connection:ServiceConnection={baseUrl:service.baseUrl,token,routes:service.routes,timeoutMs:service.timeoutMs};
  const config={...JSON.parse(fs.readFileSync(pairedFile,'utf8')),contribution:JSON.parse(fs.readFileSync(contributionFile,'utf8'))} as CpuHostConfig;
  const services:ServiceAdapter[]=[];
  const declaration=await loadServiceDeclaration(service.packs);
  for(const space of declaration.spaces){
    await verifyVectorSearchSpace(space,connection);
    services.push(vectorSearchAdapter(vectorSearchPack(space),space,connection));
  }
  for(const stage of declaration.stages)for(const capability of stage.capabilities){
    if(capability===commitCapability){services.push(commitAdapter(commitPack(stage.serviceId),connection));continue;}
    const build=stagePacks[capability];if(!build)throw Error('SERVICE_STAGE_UNSUPPORTED');
    services.push(stageAdapter(build(stage.serviceId),connection));
  }
  config.services=services;
  const host=await CpuHost.open(config,error=>{
    const ioCode=(error as NodeJS.ErrnoException)?.code;
    console.error(error instanceof Error&&/^[A-Z_]+(?::[A-Z_]+)?$/.test(error.message)?error.message:
      typeof ioCode==='string'&&/^[A-Z0-9_]+$/.test(ioCode)?'SERVICE_HOST_IO_ERROR:'+ioCode:'SERVICE_HOST_OPERATION_FAILED');
  });
  let stopping=false;const close=async()=>{if(stopping)return;stopping=true;await host.close();};
  process.once('SIGINT',()=>{void close();});process.once('SIGTERM',()=>{void close();});
  shutdown=close;if(stopRequested){await close();process.disconnect?.();return;}
  host.start();console.log('Service host started: '+services.map(s=>s.pack.manifest.contract.capability).join(', ')+' registered as ordinary execution targets.');
}
void main().catch(error=>{console.error(error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'SERVICE_HOST_START_FAILED');process.exitCode=1;if(process.connected)process.disconnect();});
