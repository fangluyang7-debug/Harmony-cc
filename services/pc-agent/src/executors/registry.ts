import path from 'node:path';
import {existsSync} from 'node:fs';
import type {ExecutionConfigV2} from '@harmony/scheduler-core';

export type CpuExecutor=(bytes:Buffer,parameters:any,config:ExecutionConfigV2,signal?:AbortSignal)=>Promise<{output:Buffer;schemaId:string}>;
export class ExecutorRegistry {
  private readonly entries=new Map<string,{executorId:string;load:()=>Promise<CpuExecutor>}>();
  register(id:string,load:()=>Promise<CpuExecutor>,executorId='node.cpu.v1'){if(this.entries.has(id))throw Error('EXECUTOR_DUPLICATE');this.entries.set(id,{executorId,load});}
  has(id:string){return this.entries.has(id);}
  executorId(id:string){return this.entries.get(id)?.executorId;}
  async load(id:string){const entry=this.entries.get(id);if(!entry)throw Error('CAPABILITY_UNSUPPORTED');return entry.load();}
}
export const cpuRegistry=new ExecutorRegistry();
cpuRegistry.register('image.crop.v1',async()=>(await import('./crop')).execute,'sharp.crop.v1');
cpuRegistry.register('vector.normalize.v1',async()=>(await import('./normalize')).execute);
cpuRegistry.register('text.count.v1',async()=>(await import('./count')).execute);
cpuRegistry.register('render.fractal.v1',async()=>(await import('./fractal')).execute);
cpuRegistry.register('catalog.filter.v1',async()=>(await import('./catalog')).execute);
if(existsSync(path.join(__dirname,'visual.node'))||existsSync(path.join(__dirname,'../visual.node')))cpuRegistry.register('image.visual-match.v1',async()=>(await import('./visual')).execute);

for(const stage of ['analyze','prepare','assemble','deliver'] as const)cpuRegistry.register('photo.'+stage+'.v1',async()=>(await import('./photo'))[stage]);
if(process.env.HARMONY_PHOTO_MODEL&&process.env.HARMONY_PHOTO_RUNNER)cpuRegistry.register('photo.enhance.v1',async()=>(await import('./photo')).enhance);
