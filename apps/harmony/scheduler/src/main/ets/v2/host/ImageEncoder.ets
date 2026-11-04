import { common } from '@kit.AbilityKit';
import { image } from '@kit.ImageKit';
import mindSporeLite from '@ohos.ai.mindSporeLite';
import { bytes, hash, text } from '../platform/NativeTransport';
import { ModelManifestV2, sameModelV2 } from '../protocol/ResourcesV2';

interface Conversion {size:number;inputLayout:string;convertedSha256:string;preprocessVersion:string;}
interface VectorOutput {model:ModelManifestV2;vector:number[];}

export async function encodeImage(context:common.UIAbilityContext,input:Uint8Array,parameters:string,
 model:ModelManifestV2,cancelled:()=>boolean):Promise<Uint8Array>{
 const requested=JSON.parse(parameters) as ModelManifestV2;
 if(!requested||!sameModelV2(requested,model))throw Error('ENCODER_MODEL_MISMATCH');
 const conversion=JSON.parse(text(await context.resourceManager.getRawFileContent('image-encoder.json'))) as Conversion;
 const size=conversion.size;
 if(!Number.isInteger(size)||size<1||size>1024||conversion.inputLayout!=='RGB_UINT8_NHWC_RESIZE'||
    conversion.preprocessVersion!==model.preprocessVersion)throw Error('ENCODER_PREPROCESS_INVALID');
 const weights=await context.resourceManager.getRawFileContent('image-encoder.ms');
 if(hash(weights)!==conversion.convertedSha256)throw Error('ENCODER_MODEL_DIGEST');
 if(cancelled())throw Error('CANCELLED_SETTLED');
 const src=image.createImageSource(input.slice().buffer as ArrayBuffer);
 let pixels:image.PixelMap|null=null;
 const rgb=new Uint8Array(size*size*3);
 try{
  const original=await src.getImageInfo();
  if(original.size.width*original.size.height>16777216)throw Error('IMAGE_SIZE_LIMIT');
  pixels=await src.createPixelMap({desiredSize:{width:size,height:size},desiredPixelFormat:image.PixelMapFormat.RGBA_8888});
  const info=await pixels.getImageInfo();
  if(info.size.width!==size||info.size.height!==size)throw Error('ENCODER_PREPROCESS_SIZE');
  const rgba=new Uint8Array(size*size*4);
  await pixels.readPixelsToBuffer(rgba.buffer as ArrayBuffer);
  for(let i=0;i<size*size;i++){rgb[i*3]=rgba[i*4];rgb[i*3+1]=rgba[i*4+1];rgb[i*3+2]=rgba[i*4+2];}
 }finally{await pixels?.release();await src.release();}
 if(cancelled())throw Error('CANCELLED_SETTLED');
 const runtime:mindSporeLite.Context={target:['cpu'],cpu:{threadNum:1,threadAffinityMode:mindSporeLite.ThreadAffinityMode.NO_AFFINITIES,precisionMode:'enforce_fp32'}};
 const engine=await mindSporeLite.loadModelFromBuffer(weights.slice().buffer as ArrayBuffer,runtime);
 const inputs=engine.getInputs();
 if(inputs.length!==1||inputs[0].dtype!==mindSporeLite.DataType.NUMBER_TYPE_UINT8||inputs[0].shape.join(',')!==[1,size,size,3].join(','))throw Error('ENCODER_INPUT_LAYOUT');
 inputs[0].setData(rgb.buffer as ArrayBuffer);
 const outputs=await engine.predict(inputs);
 if(cancelled())throw Error('CANCELLED_SETTLED');
 if(outputs.length!==1||outputs[0].dtype!==mindSporeLite.DataType.NUMBER_TYPE_FLOAT32)throw Error('ENCODER_OUTPUT_INVALID');
 const vector=Array.from(new Float32Array(outputs[0].getData()));
 if(vector.length!==model.dimension||!vector.every((x:number)=>Number.isFinite(x)))throw Error('ENCODER_OUTPUT_INVALID');
 const norm=Math.sqrt(vector.reduce((sum:number,x:number)=>sum+x*x,0));
 if(!Number.isFinite(norm)||norm<=0)throw Error('ENCODER_OUTPUT_INVALID');
 const output:VectorOutput={model,vector:vector.map((x:number)=>x/norm)};
 return bytes(JSON.stringify(output));
}
