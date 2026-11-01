import sharp from 'sharp';
import { CapabilityPackV2, ExecutionConfigV2 } from '@harmony/scheduler-core';

/** Trusted reference suite checks geometry and pixel colors, independently of the crop implementation. */
export async function cropEvaluationPack(manifest:CapabilityPackV2){
  if(manifest.packId!=='image.crop.v1'||manifest.suiteId!=='crop.geometry-colour.v1'||manifest.contract.capability!=='image.crop.v1')throw Error('CROP_PACK_INVALID');
  const raw=Buffer.alloc(64*32*3);
  for(let y=0;y<32;y++)for(let x=0;x<64;x++)raw[(y*64+x)*3+(x<32?0:2)]=255;
  const input=await sharp(raw,{raw:{width:64,height:32,channels:3}}).png().toBuffer();
  const config:ExecutionConfigV2={id:'standard',threads:1,batchSize:1,quality:'standard'};
  const cases=[{id:'left',x:0},{id:'right',x:.5}].map(c=>({id:c.id,input:Buffer.from(input),config,
    parameters:JSON.stringify({box:{x:c.x,y:0,width:.5,height:1},paddingRatio:0,targetSize:32,jpegQuality:90}),maxOutputBytes:65536}));
  return {manifest,cases,maxOutputBytes:8388608,evaluate:async(test:{id:string},output:Buffer)=>{
    const image=sharp(output,{limitInputPixels:1024}),meta=await image.metadata();
    if(meta.width!==32||meta.height!==32||meta.format!=='jpeg'||!['left','right'].includes(test.id))return 0;
    const pixels=await image.removeAlpha().raw().toBuffer();let correct=0;const expected=test.id==='left'?[255,0,0]:[0,0,255];
    for(let i=0;i<pixels.length;i+=3)if(expected.every((v,c)=>Math.abs(v-pixels[i+c])<=10))correct++;
    return correct/1024;
  }};
}

export async function validRaster(bytes:Buffer):Promise<boolean>{try{const meta=await sharp(bytes,{limitInputPixels:16777216}).metadata();return !!meta.width&&!!meta.height&&["png","jpeg"].includes(meta.format??"");}catch{return false;}}
