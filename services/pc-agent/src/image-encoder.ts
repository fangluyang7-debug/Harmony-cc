import {gpuReady} from './cpu-engine';
import {promisify} from 'node:util';
import {spawn,execFile} from 'node:child_process';
import {ReferencePack,cpuSchemas,loadImageEncodingPack} from '@harmony/reference-capabilities';
import {DispatchOfferV2,ModelManifestV2,sameModelV2} from '@harmony/scheduler-core';

export const imageExecutorId='pc.image.cpu.v1';
export const cudaExecutorId='pc.image.cuda.v1';
export interface ImageEncoder {
  pack:ReferencePack;
  gpu?:{totalBytes:number;limit:number;freeBytes():Promise<number>};
  execute(offer:DispatchOfferV2,input:Buffer,signal:AbortSignal):Promise<{bytes:Buffer;schemaId:string;model:ModelManifestV2}>;
}
function run(command:string,args:string[],input:Buffer,limit:number,signal:AbortSignal):Promise<Buffer>{
  if(signal.aborted)throw Error('CANCELLED_SETTLED');
  return new Promise<Buffer>((resolve,reject)=>{
      const child=spawn(command,args,{windowsHide:true,stdio:['pipe','pipe','ignore']});
      const chunks:Buffer[]=[];let size=0;
      const kill=()=>{child.kill('SIGKILL');};
      signal.addEventListener('abort',kill,{once:true});
      child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size<=limit)chunks.push(chunk);else kill();});
      child.on('error',()=>reject(Error('ENCODER_PROCESS_UNAVAILABLE')));
      child.once('close',code=>{
        signal.removeEventListener('abort',kill);
        if(signal.aborted)reject(Error('CANCELLED_SETTLED'));
        else if(code!==0||size>limit)reject(Error('ENCODER_PROCESS_FAILED'));
        else resolve(Buffer.concat(chunks));
      });
      child.stdin.on('error',()=>{});child.stdin.end(input);
    });
}

export async function openImageEncoder(suite:string,command:string,script:string,cuda=false):Promise<ImageEncoder>{
  const pack=await loadImageEncodingPack(suite),model=pack.manifest.model!;
  const executorId=cuda?cudaExecutorId:imageExecutorId,args=cuda?[script,'--cuda']:[script];
  if(!pack.manifest.executorIds.includes(executorId))throw Error('ENCODER_NOT_IN_SUITE');
  let gpu:ImageEncoder['gpu'];
  if(cuda){
    const bytes=await run(command,[...args,'--probe'],pack.cases[0].input,8192,AbortSignal.timeout(120000));
    const h=JSON.parse(bytes.toString()),limit=pack.manifest.resourceLimit.find(r=>r.resourcePoolId==='vram')!.amount;
    if(!gpuReady(h)||h.modelHash!==model.weightsHash||!h.model||!sameModelV2(model,h.model)||
      !Number.isSafeInteger(h.totalBytes)||h.totalBytes<limit||typeof h.uuid!=='string'||
      !/^(?:GPU-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(h.uuid))throw Error('CUDA_PROBE_INVALID');
    const uuid=h.uuid.startsWith('GPU-')?h.uuid:'GPU-'+h.uuid;
    gpu={totalBytes:h.totalBytes,limit,async freeBytes(){
      try{
        const {stdout}=await promisify(execFile)('nvidia-smi',['-i',uuid,'--query-gpu=memory.free','--format=csv,noheader,nounits'],{windowsHide:true,timeout:2000});
        const value=stdout.trim();return /^\d+$/.test(value)?Math.min(h.totalBytes,Number(value)*1048576):0;
      }catch{return 0;}
    }};
  }
  return {pack,gpu,async execute(offer,input,signal){
    const expected=JSON.parse(offer.task.parameters);
    if(offer.target.executorId!==executorId||offer.target.backend!==(cuda?'CUDA':'CPU')||!expected||!sameModelV2(expected,model))throw Error('ENCODER_SCOPE');
    if(!input.length)throw Error('IMAGE_INVALID');
    const bytes=await run(command,args,input,pack.maxOutputBytes,signal);
    if(!await cpuSchemas.get('image.embedding:1')!(bytes))throw Error('ENCODER_OUTPUT_INVALID');
    const output=JSON.parse(bytes.toString('utf8')),actual=output.model;
    if(cuda&&output.backend!=='CUDA')throw Error('CUDA_BACKEND_MISMATCH');
    if(!sameModelV2(actual,model))throw Error('ENCODER_MODEL_MISMATCH');
    return {bytes,schemaId:'image.embedding',model:actual};
  }};
}
