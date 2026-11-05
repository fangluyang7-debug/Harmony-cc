import sharp from 'sharp';
import type {CpuExecutor} from './registry';

export const execute:CpuExecutor=async(bytes,parameters,config)=>{
  const p=parameters,b=p.box,padding=p.paddingRatio;
  if(!b||![b.x,b.y,b.width,b.height,padding].every(Number.isFinite)||b.x<0||b.y<0||b.width<=0||b.height<=0||b.x+b.width>1||b.y+b.height>1||padding<0||padding>.5||!Number.isSafeInteger(p.targetSize)||p.targetSize<32||p.targetSize>1024||!Number.isSafeInteger(p.jpegQuality)||p.jpegQuality<40||p.jpegQuality>95)throw Error('CROP_INVALID');
  sharp.concurrency(config.threads);if(!bytes.length)throw Error('IMAGE_INVALID');
  const metadata=await sharp(bytes,{limitInputPixels:16777216}).metadata().catch(()=>{throw Error('IMAGE_INVALID');});const width=metadata.width!,height=metadata.height!;
  if(!width||!height)throw Error('IMAGE_INVALID');
  const cx=(b.x+b.width/2)*width,cy=(b.y+b.height/2)*height,side=Math.min(Math.max(b.width*width,b.height*height)*(1+padding*2),Math.max(width,height));
  const clamp=(v:number,min:number,max:number)=>Math.min(max,Math.max(min,v)),left=clamp(Math.round(cx-side/2),0,width-1),top=clamp(Math.round(cy-side/2),0,height-1);
  return {output:await sharp(bytes,{limitInputPixels:16777216}).extract({left,top,width:clamp(Math.round(cx+side/2),left+1,width)-left,height:clamp(Math.round(cy+side/2),top+1,height)-top})
    .resize({width:p.targetSize,height:p.targetSize,fit:'contain',background:{r:245,g:245,b:245,alpha:1}}).jpeg({quality:p.jpegQuality,mozjpeg:true}).toBuffer(),schemaId:'image.raster'};
};
