import './photo-installation';
import {openPhotoAccelerator} from './photo-accelerator';
import path from 'node:path';
import {openImageEncoder} from './image-encoder';
import fs from 'node:fs';
import { CpuHost, CpuHostConfig } from './host';
import {validateDataHostConfig} from './data-host';
import {CoordinatorGoneDetector} from './coordinator-gone';
let stopRequested=false,shutdown:(()=>Promise<void>)|null=null;
process.on('message',(message:any)=>{if(message==='stop'||message?.type==='shutdown'){stopRequested=true;if(shutdown)void shutdown().then(()=>process.disconnect?.());}});
async function main(){
  const [pairedFile,contributionFile,networkFile]=process.argv.slice(2);if(!pairedFile||!contributionFile)throw Error('HOST_ARGUMENTS');
  const config={...JSON.parse(fs.readFileSync(pairedFile,'utf8')),contribution:JSON.parse(fs.readFileSync(contributionFile,'utf8'))} as CpuHostConfig;
  if(networkFile)config.dataEndpoint=JSON.parse(fs.readFileSync(networkFile,'utf8'));
  if(config.dataEndpoint!==undefined&&config.dataEndpoint!==false)validateDataHostConfig(config.dataEndpoint);
  // Keep the on-disk policy in step with the automatic ceiling so the desktop quota panel and restarts see it.
  config.onContributionChanged=contribution=>{try{fs.writeFileSync(contributionFile,JSON.stringify(contribution),{mode:0o600});}catch{console.error('CONTRIBUTION_SAVE_FAILED');}};
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
  // Photo GPU: probe whenever a Vulkan engine is installed and the owner has not fixed a zero VRAM share.
  // Under automatic capacity the coordinator derives the VRAM share from the probed GPU, so the share
  // cannot be a precondition of the probe (that ordering left every auto-paired GPU machine on CPU only).
  if(process.env.HARMONY_PHOTO_VULKAN&&!config.imageEncoder){
    const gpuAllowed=config.contribution.capacityMode==='auto'||(config.contribution.maxVramBytes??0)>0;
    if(!gpuAllowed)console.error('PHOTO_GPU_NOT_CONTRIBUTED: fixed contribution has no VRAM share; set maxVramBytes or use automatic capacity.');
    else try{
      config.imageEncoder=await openPhotoAccelerator();
      console.log('PHOTO_GPU_READY: VULKAN device '+process.env.HARMONY_PHOTO_GPU_ID+', '+Math.round((config.imageEncoder.gpu?.totalBytes??0)/1048576)+' MiB; the coordinator sets the VRAM share from this measurement.');
    }catch(error){
      const reason=error instanceof Error&&/^PHOTO_GPU_[A-Z_]+$/.test(error.message)?error.message:'PHOTO_GPU_PROBE_FAILED';
      console.error('PHOTO_GPU_UNAVAILABLE '+reason+': only CPU photo capabilities will be advertised. '+({PHOTO_GPU_RUNTIME_MISSING:'The Vulkan engine file is missing from this installation.',PHOTO_GPU_DRIVER_MISSING:'nvidia-smi is not available; install the NVIDIA driver.',PHOTO_GPU_DEVICE_UNMATCHED:'No Vulkan device matches an NVIDIA GPU; check HARMONY_PHOTO_GPU_ID and vulkan-1.dll from the driver.',PHOTO_GPU_MEMORY_TOO_SMALL:'The matched GPU has less than 512 MiB.',PHOTO_GPU_QUALITY_FAILED:'The reference inference did not reach the quality threshold.',PHOTO_GPU_PROBE_FAILED:'The reference inference did not finish; check vcomp140.dll beside the engine and the driver.'} as Record<string,string>)[reason]);
    }
  }else if(process.env.HARMONY_PHOTO_MODEL&&!process.env.HARMONY_PHOTO_VULKAN)console.log('PHOTO_GPU_RUNTIME_MISSING: no Vulkan engine configured; photo enhancement runs on CPU only.');
  const detector=new CoordinatorGoneDetector();let gone=false;
  const host=await CpuHost.open(config,error=>{
    if(!gone&&detector.observe(error,Date.now())){gone=true;console.log('COORDINATOR_GONE: coordinator stopped or unreachable; pairing will be cleared.');
      void (shutdown?.()??Promise.resolve()).then(()=>{process.exitCode=3;process.disconnect?.();setTimeout(()=>process.exit(3),3000).unref();});}
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
void main().catch(error=>{console.error(error instanceof Error&&error.message==='DATA_HOST_CONFIG_INVALID'?
  'DATA_HOST_CONFIG_INVALID: check listenHost, advertisedHost and port in the network configuration.':
  'CPU_HOST_START_FAILED: check paired configuration, contribution policy and optional network file.');process.exitCode=1;if(process.connected)process.disconnect();});
