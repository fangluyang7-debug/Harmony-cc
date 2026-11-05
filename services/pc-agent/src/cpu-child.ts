import { createHash } from 'node:crypto';
import {cpuRegistry} from './executors/registry';
import { performance } from 'node:perf_hooks';

process.on('disconnect',()=>process.exit(1));
process.once('message',async(raw:any)=>{
  try{
    const bytes=Buffer.from(raw.input,'base64');if(bytes.length>8388608||createHash('sha256').update(bytes).digest('hex')!==raw.hash)throw Error('INPUT_HASH');
    if(!Number.isSafeInteger(raw.config.threads)||raw.config.threads<1||raw.config.threads>64||!Number.isSafeInteger(raw.config.batchSize)||raw.config.batchSize<1||raw.config.batchSize>1024||raw.config.quality!=='standard')throw Error('CONFIG_UNSUPPORTED');
    const execute=await cpuRegistry.load(raw.capability);
    const started=performance.now();
    const {output,schemaId}=await execute(bytes,raw.parameters,raw.config);
    const durationMs=performance.now()-started;
    if(output.length>8388608)throw Error('OUTPUT_TOO_LARGE');
    process.send?.({ok:true,output:output.toString('base64'),hash:createHash('sha256').update(output).digest('hex'),schemaId,durationMs},()=>process.disconnect());
  }catch(error){process.send?.({ok:false,error:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'CPU_FAILED'},()=>process.disconnect());}
});
