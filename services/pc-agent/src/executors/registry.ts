import type {ExecutionConfigV2} from '@harmony/scheduler-core';

export type CpuExecutor=(bytes:Buffer,parameters:any,config:ExecutionConfigV2)=>Promise<{output:Buffer;schemaId:string}>;
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
