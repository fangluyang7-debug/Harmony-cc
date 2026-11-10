import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {photoPacks} from '@harmony/reference-capabilities';
import {ImageEncoder} from './image-encoder';
import {enhanceOn,geometry} from './executors/photo';
export const photoVulkanExecutorId='ncnn.photo.vulkan.v1';
/** Register only after a real Vulkan inference, matching NVIDIA device name and reference output. */
export async function openPhotoAccelerator():Promise<ImageEncoder>{
 const pack=photoPacks().find(p=>p.manifest.contract.capability==='photo.enhance.v1');if(!pack||!process.env.HARMONY_PHOTO_VULKAN)throw Error('PHOTO_GPU_UNAVAILABLE');
 const {stdout}=await promisify(execFile)('nvidia-smi',['--query-gpu=uuid,name,memory.total','--format=csv,noheader,nounits'],{windowsHide:true,timeout:5000});
 const devices=stdout.trim().split(/\r?\n/).map(line=>{const [uuid,name,total]=line.split(',').map(s=>s.trim());return {uuid,name,totalBytes:Number(total)*1048576};});
 let log='';const output=await enhanceOn(pack.cases[0].input,1,'VULKAN',AbortSignal.timeout(120000),s=>{log=s;});
 const gpuId=process.env.HARMONY_PHOTO_GPU_ID??'0',device=devices.find(d=>d.name&&log.includes('['+gpuId+' '+d.name+']'));
 if(!device||!Number.isSafeInteger(device.totalBytes)||device.totalBytes<536870912||await pack.evaluate(pack.cases[0],output.output)<pack.manifest.qualityThreshold)throw Error('PHOTO_GPU_PROBE_FAILED');
 return {pack,backend:'VULKAN',gpu:{totalBytes:device.totalBytes,limit:device.totalBytes,async freeBytes(){const r=await promisify(execFile)('nvidia-smi',['-i',device.uuid,'--query-gpu=memory.free','--format=csv,noheader,nounits'],{windowsHide:true,timeout:3000});const n=Number(r.stdout.trim());return Number.isFinite(n)&&n>=0?n*1048576:0;}},async execute(offer,input,signal){if(offer.target.backend!=='VULKAN'||offer.target.executorId!==photoVulkanExecutorId)throw Error('PHOTO_GPU_SCOPE');const tile=JSON.parse(input.toString());geometry(JSON.parse(offer.task.parameters),tile.rect?.width,tile.rect?.height);const r=await enhanceOn(input,1,'VULKAN',signal);return {bytes:r.output,schemaId:r.schemaId,model:pack.manifest.model!};}};
}
