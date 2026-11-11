import fs from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {photoPacks} from '@harmony/reference-capabilities';
import {ImageEncoder} from './image-encoder';
import {enhanceOn,enhancementInput} from './executors/photo';
export const photoVulkanExecutorId='ncnn.photo.vulkan.v1';
export interface VulkanDevice {index:number;name:string;}
export interface NvidiaDevice {uuid:string;name:string;totalBytes:number;}
/** realesrgan-ncnn-vulkan lists every Vulkan device on stderr as "[N name]  queueC=..". */
export function parseVulkanDevices(log:string):VulkanDevice[]{
 const devices:VulkanDevice[]=[];
 for(const match of log.matchAll(/^\[(\d+) ([^\]\r\n]+?)\]/gm))devices.push({index:Number(match[1]),name:match[2].trim()});
 return devices;
}
/**
 * The Vulkan index that is backed by an NVIDIA device. On laptops the integrated GPU is often Vulkan
 * device 0, so "0" is never assumed: an explicit HARMONY_PHOTO_GPU_ID must itself match an NVIDIA
 * device; otherwise the first matching index is chosen.
 */
export function selectVulkanDevice<T extends {name:string}>(vulkan:VulkanDevice[],nvidia:T[],preferred:string|undefined):{index:number;device:T}|null{
 const same=(a:string,b:string)=>a.trim().toLowerCase()===b.trim().toLowerCase();
 const candidates=vulkan.flatMap(v=>{const device=nvidia.find(d=>d.name&&same(v.name,d.name));return device?[{index:v.index,device}]:[];});
 if(preferred!==undefined&&preferred!==''){const index=Number(preferred);return candidates.find(c=>c.index===index)??null;}
 return candidates[0]??null;
}
async function nvidiaDevices():Promise<NvidiaDevice[]>{
 let stdout='';
 try{({stdout}=await promisify(execFile)('nvidia-smi',['--query-gpu=uuid,name,memory.total','--format=csv,noheader,nounits'],{windowsHide:true,timeout:5000}));}
 catch{throw Error('PHOTO_GPU_DRIVER_MISSING');}
 const devices=stdout.trim().split(/\r?\n/).filter(Boolean).map(line=>{const [uuid,name,total]=line.split(',').map(s=>s.trim());return {uuid,name,totalBytes:Number(total)*1048576};});
 if(!devices.length)throw Error('PHOTO_GPU_DRIVER_MISSING');
 return devices;
}
/**
 * Register only after a real Vulkan inference on a matched NVIDIA device whose output passes the reference check.
 * Failure reasons are distinct so the owner can tell a missing engine from a missing driver or a wrong GPU:
 * PHOTO_GPU_RUNTIME_MISSING, PHOTO_GPU_DRIVER_MISSING, PHOTO_GPU_DEVICE_UNMATCHED, PHOTO_GPU_MEMORY_TOO_SMALL,
 * PHOTO_GPU_PROBE_FAILED, PHOTO_GPU_QUALITY_FAILED.
 */
export async function openPhotoAccelerator():Promise<ImageEncoder>{
 const pack=photoPacks().find(p=>p.manifest.contract.capability==='photo.enhance.v1'),engine=process.env.HARMONY_PHOTO_VULKAN;
 if(!pack||!engine||!fs.existsSync(engine))throw Error('PHOTO_GPU_RUNTIME_MISSING');
 const devices=await nvidiaDevices();
 // The first run lists the Vulkan devices even when the default device cannot finish the inference.
 const probe=async(index:string)=>{process.env.HARMONY_PHOTO_GPU_ID=index;let log='';let output:Buffer|null=null;
  try{output=(await enhanceOn(pack.cases[0].input,1,'VULKAN',AbortSignal.timeout(120000),s=>{log=s;})).output;}catch{output=null;}
  return {log,output};};
 const requested=process.env.HARMONY_PHOTO_GPU_ID;
 let run=await probe(requested??'0');
 const selected=selectVulkanDevice(parseVulkanDevices(run.log),devices,requested);
 if(!selected)throw Error('PHOTO_GPU_DEVICE_UNMATCHED');
 if(String(selected.index)!==(requested??'0'))run=await probe(String(selected.index));
 if(!run.output)throw Error('PHOTO_GPU_PROBE_FAILED');
 const device=selected.device;
 if(!Number.isSafeInteger(device.totalBytes)||device.totalBytes<536870912)throw Error('PHOTO_GPU_MEMORY_TOO_SMALL');
 const score=await pack.evaluate(pack.cases[0],run.output);
 if(score<pack.manifest.qualityThreshold)throw Object.assign(Error('PHOTO_GPU_QUALITY_FAILED'),{diagnostic:{score,required:pack.manifest.qualityThreshold,device:device.name,index:selected.index,runtime:process.env.HARMONY_PHOTO_VULKAN_RUNTIME??'legacy-realesrgan-cli'}});
 process.env.HARMONY_PHOTO_GPU_ID=String(selected.index);
 return {pack,backend:'VULKAN',gpu:{totalBytes:device.totalBytes,limit:device.totalBytes,async freeBytes(){const r=await promisify(execFile)('nvidia-smi',['-i',device.uuid,'--query-gpu=memory.free','--format=csv,noheader,nounits'],{windowsHide:true,timeout:3000});const n=Number(r.stdout.trim());return Number.isFinite(n)&&n>=0?n*1048576:0;}},async execute(offer,input,signal){if(offer.target.backend!=='VULKAN'||offer.target.executorId!==photoVulkanExecutorId)throw Error('PHOTO_GPU_SCOPE');input=await enhancementInput(input,JSON.parse(offer.task.parameters),offer.allowedConfigs[0]);const r=await enhanceOn(input,1,'VULKAN',signal);return {bytes:r.output,schemaId:r.schemaId,model:pack.manifest.model!};}};
}
