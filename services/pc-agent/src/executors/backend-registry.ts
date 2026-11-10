import {photoVulkanExecutorId} from '../photo-accelerator';
import {photoReference} from '@harmony/reference-capabilities';
import {createHash} from 'node:crypto';
import {canonical,DispatchOfferV2,ExecutionConfigV2,ModelManifestV2} from '@harmony/scheduler-core';
import {executeCpu} from '../cpu-engine';
import {cudaExecutorId,imageExecutorId,ImageEncoder} from '../image-encoder';

interface Output {bytes:Buffer;schemaId:string;hash:string;durationMs?:number;model?:ModelManifestV2;}
type Backend=(offer:DispatchOfferV2,bytes:Buffer,config:ExecutionConfigV2,signal:AbortSignal)=>Promise<Output>;
type Adapter=(offer:DispatchOfferV2,bytes:Buffer,signal:AbortSignal)=>Promise<{bytes:Buffer;schemaId:string}>;
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export class BackendRegistry {
  private readonly engines=new Map<string,Backend>();
  constructor(encoder?:ImageEncoder,private readonly service?:Adapter){
    const image:Backend=async(offer,bytes,_config,signal)=>{
      if(!encoder||canonical(encoder.pack.manifest.contract)!==canonical(offer.task.contract))throw Error('ENCODER_SCOPE');
      const output=await encoder.execute(offer,bytes,signal);return {...output,hash:digest(output.bytes)};
    };
    this.engines.set(imageExecutorId,image);this.engines.set(cudaExecutorId,image);this.engines.set(photoVulkanExecutorId,image);
  }
  async run(offer:DispatchOfferV2,bytes:Buffer,config:ExecutionConfigV2,signal:AbortSignal):Promise<Output>{
    const installed=this.engines.get(offer.target.executorId);
    if(installed)return installed(offer,bytes,config,signal);
    if(!offer.task.contract.serviceId){const result=await executeCpu(offer.task.contract.capability,bytes,JSON.parse(offer.task.parameters),config,signal);return {...result,...(offer.task.contract.capability==='photo.enhance.v1'?{model:photoReference().model}:{})};}
    if(!this.service)throw Error('SERVICE_ADAPTER_REQUIRED');
    const output=await this.service(offer,bytes,signal);
    if(!output.bytes.length||output.bytes.length>8388608)throw Error('SERVICE_OUTPUT_INVALID');
    return {...output,hash:digest(output.bytes)};
  }
}
