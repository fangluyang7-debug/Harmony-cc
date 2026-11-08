import path from 'node:path';
import {openImageEncoder} from './image-encoder';
import fs from 'node:fs';
import { CpuHost, CpuHostConfig } from './host';
let stopRequested=false,shutdown:(()=>Promise<void>)|null=null;
process.on('message',(message:any)=>{if(message==='stop'||message?.type==='shutdown'){stopRequested=true;if(shutdown)void shutdown().then(()=>process.disconnect?.());}});
async function main(){
  const [pairedFile,contributionFile]=process.argv.slice(2);if(!pairedFile||!contributionFile)throw Error('HOST_ARGUMENTS');
  const config={...JSON.parse(fs.readFileSync(pairedFile,'utf8')),contribution:JSON.parse(fs.readFileSync(contributionFile,'utf8'))} as CpuHostConfig;
  const suite=process.env.PC_IMAGE_ENCODING_SUITE;
  if(suite){
    const backend=process.env.PC_IMAGE_BACKEND??'CPU';
    if(!['CPU','CUDA'].includes(backend))throw Error('ENCODER_BACKEND_INVALID');
    try{
      config.imageEncoder=await openImageEncoder(suite,process.env.PC_IMAGE_PYTHON??'python',
        path.resolve(__dirname,'../../image-worker/encode_once.py'),backend==='CUDA');
    }catch(error){
      const reason=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'ENCODER_SETUP_FAILED';
      console.error('IMAGE_TARGET_UNAVAILABLE '+reason);
    }
  }
  const host=await CpuHost.open(config,error=>{
    const ioCode=(error as NodeJS.ErrnoException)?.code;
    // Preserve actionable codes without logging paths, task input or credentials.
    console.error(error instanceof Error&&/^[A-Z_]+(?::[A-Z_]+)?$/.test(error.message)?error.message:
      typeof ioCode==='string'&&/^[A-Z0-9_]+$/.test(ioCode)?'CPU_HOST_IO_ERROR:'+ioCode:'CPU_HOST_OPERATION_FAILED');
  });
  let stopping=false;const close=async()=>{if(stopping)return;stopping=true;await host.close();};
  process.once('SIGINT',()=>{void close();});process.once('SIGTERM',()=>{void close();});
  shutdown=close;if(stopRequested){await close();process.disconnect?.();return;}
  host.start();console.log('CPU host started: automatic profiles, calibration and execution enabled.');
}
void main().catch(()=>{console.error('CPU_HOST_START_FAILED: check paired configuration and contribution policy.');process.exitCode=1;if(process.connected)process.disconnect();});
