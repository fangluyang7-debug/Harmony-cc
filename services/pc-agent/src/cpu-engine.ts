import { fork, ForkOptions } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ExecutionConfigV2, validExecutionConfigV2 } from '@harmony/scheduler-core';

export interface CpuResult {bytes:Buffer;hash:string;schemaId:string;durationMs:number;backend:'CPU';}
/** Every invocation owns one disposable process; abort resolves only after its exit event. */
export function executeCpu(capability:string,input:Buffer,parameters:unknown,config:ExecutionConfigV2,signal:AbortSignal):Promise<CpuResult>{
  if(!validExecutionConfigV2(config)||input.length>8388608||!['image.crop.v1','vector.normalize.v1','text.count.v1'].includes(capability))return Promise.reject(Error('CPU_REQUEST_INVALID'));
  if(signal.aborted)return Promise.reject(Error('CANCELLED_SETTLED'));
  return new Promise((resolve,reject)=>{
    const options:ForkOptions&{windowsHide:boolean}={windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],execArgv:['--max-old-space-size=256']};
    const child=fork(path.join(__dirname,'cpu-child.js'),[],options);
    let result:any,transportError=false;
    const abort=()=>{child.kill();};signal.addEventListener('abort',abort,{once:true});
    child.once('message',m=>{result=m;});child.on('error',()=>{transportError=true;child.kill();});
    child.once('close',()=>{
      signal.removeEventListener('abort',abort);
      if(signal.aborted){reject(Error('CANCELLED_SETTLED'));return;}
      if(transportError||!result?.ok){reject(Error(result?.error??'CPU_PROCESS_FAILED'));return;}
      const bytes=Buffer.from(result.output,'base64');
      if(bytes.length>8388608||createHash('sha256').update(bytes).digest('hex')!==result.hash||!Number.isFinite(result.durationMs)||result.durationMs<0){reject(Error('CPU_RESULT_INVALID'));return;}
      resolve({bytes,hash:result.hash,schemaId:result.schemaId,durationMs:result.durationMs,backend:'CPU'});
    });
    child.send({capability,input:input.toString('base64'),hash:createHash('sha256').update(input).digest('hex'),parameters,config},error=>{if(error){transportError=true;child.kill();}});
    if(signal.aborted)abort();
  });
}
/** GPU registration requires an actual CUDA engine, loaded model and a readable health response. No CPU fallback is relabelled GPU. */
export function gpuReady(health:unknown):boolean{
  const h=health as {cudaAvailable?:boolean;backend?:string;modelLoaded?:boolean;modelHash?:string};
  return !!h&&h.cudaAvailable===true&&h.backend==='CUDA'&&h.modelLoaded===true&&typeof h.modelHash==='string'&&/^[a-f0-9]{64}$/.test(h.modelHash);
}
