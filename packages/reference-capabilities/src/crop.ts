import {tolerancePack} from './evaluation';
import type {ReferenceCase} from './index';
import sharp from 'sharp';
import { CapabilityPackV2, ExecutionConfigV2 } from '@harmony/scheduler-core';

/** Trusted reference suite checks geometry and pixel colors, independently of the crop implementation. */
export async function cropEvaluationPack(manifest:CapabilityPackV2){
  if(manifest.packId!=='image.crop.v1'||manifest.suiteId!=='crop.geometry-colour.v1'||manifest.contract.capability!=='image.crop.v1')throw Error('CROP_PACK_INVALID');
  const raw=Buffer.alloc(64*32*3);
  for(let y=0;y<32;y++)for(let x=0;x<64;x++)raw[(y*64+x)*3+(x<32?0:2)]=255;
  const input=await sharp(raw,{raw:{width:64,height:32,channels:3}}).png().toBuffer();
  const left={x:0,y:0,width:.5,height:1},right={...left,x:.5};
  const config:ExecutionConfigV2={id:'standard',threads:1,batchSize:1,quality:'standard'};
  const solid=await sharp({create:{width:32,height:32,channels:3,background:{r:255,g:0,b:0}}}).png().toBuffer();
  const schema='schema:image.raster';
  const make=(id:string,data:Buffer,box:typeof left,size:number,quality:number,padding:number,tags:string[],color:number[],error?:string):ReferenceCase=>({
    id,input:data,config,parameters:JSON.stringify({box,paddingRatio:padding,targetSize:size,jpegQuality:quality}),maxOutputBytes:65536,
    covers:[schema,...tags],expect:error?{kind:'REJECT',errorCode:error}:{kind:'OUTPUT'},expected:error?undefined:{size,color,format:'jpeg',tolerance:10,metricVersion:1}});
  const cases=[make('left',input,left,32,90,0,['encoder:jpeg','param:targetSize:min'],[255,0,0]),
    make('right',input,right,32,90,0,[],[0,0,255]),make('max',solid,{x:0,y:0,width:1,height:1},1024,95,.5,['boundary:max','param:targetSize:max','param:jpegQuality:max'],[255,0,0]),
    make('low-quality',solid,{x:0,y:0,width:1,height:1},32,40,0,['param:jpegQuality:min'],[255,0,0]),
    make('empty',Buffer.alloc(0),left,32,90,0,['boundary:empty'],[],'IMAGE_INVALID'),make('invalid',Buffer.from('invalid'),left,32,90,0,[],[],'IMAGE_INVALID')];
  return {manifest,cases,maxOutputBytes:8388608,evaluate:async(test:{id:string},output:Buffer)=>{
    const c=cases.find(c=>c.id===test.id);if(!c||c.expect?.kind!=='OUTPUT')return 0;
    const expected=c.expected as {size:number;color:number[];format:string;tolerance:number};
    const image=sharp(output,{limitInputPixels:1024*1024}),meta=await image.metadata();
    if(meta.width!==expected.size||meta.height!==expected.size||meta.format!==expected.format)return 0;
    const pixels=await image.removeAlpha().raw().toBuffer();let correct=0;
    for(let i=0;i<pixels.length;i+=3)if(expected.color.every((v,ch)=>Math.abs(v-pixels[i+ch])<=expected.tolerance))correct++;
    return tolerancePack((matches:number,total:number)=>matches/total)(correct,pixels.length/3);
  }};
}

export async function validRaster(bytes:Buffer,expectedFormat?:string):Promise<boolean>{try{const meta=await sharp(bytes,{limitInputPixels:16777216}).metadata();return !!meta.width&&!!meta.height&&["png","jpeg"].includes(meta.format??"")&&(!expectedFormat||meta.format===expectedFormat);}catch{return false;}}
