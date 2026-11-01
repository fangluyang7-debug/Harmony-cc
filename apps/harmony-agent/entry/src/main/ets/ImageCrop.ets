import { image } from '@kit.ImageKit';
interface Box {x:number;y:number;width:number;height:number;}
interface CropParameters {box:Box;paddingRatio:number;targetSize:number;jpegQuality:number;}
const clamp=(v:number,min:number,max:number):number=>Math.min(max,Math.max(min,v));
/** ImageKit uses the same crop geometry, contain resize and grey padding as the PC contract. */
export async function cropImage(input:Uint8Array,parameters:string):Promise<Uint8Array>{
 const p=JSON.parse(parameters) as CropParameters,b=p.box;
 if(!b||![b.x,b.y,b.width,b.height,p.paddingRatio].every(Number.isFinite)||b.x<0||b.y<0||b.width<=0||b.height<=0||b.x+b.width>1||b.y+b.height>1||p.paddingRatio<0||p.paddingRatio>.5||!Number.isSafeInteger(p.targetSize)||p.targetSize<32||p.targetSize>1024||!Number.isSafeInteger(p.jpegQuality)||p.jpegQuality<40||p.jpegQuality>95)throw Error('CROP_INVALID');
 const source=image.createImageSource(input.buffer as ArrayBuffer);let pixels:image.PixelMap|null=null,canvas:image.PixelMap|null=null;const packer=image.createImagePacker();
 try{
  const info=await source.getImageInfo();const width=info.size.width,height=info.size.height;if(width*height>16777216||!width||!height)throw Error('IMAGE_INVALID');
  pixels=await source.createPixelMap({editable:true,desiredPixelFormat:image.PixelMapFormat.RGBA_8888});
  const cx=(b.x+b.width/2)*width,cy=(b.y+b.height/2)*height,side=Math.min(Math.max(b.width*width,b.height*height)*(1+p.paddingRatio*2),Math.max(width,height));
  const left=clamp(Math.round(cx-side/2),0,width-1),top=clamp(Math.round(cy-side/2),0,height-1),cropWidth=clamp(Math.round(cx+side/2),left+1,width)-left,cropHeight=clamp(Math.round(cy+side/2),top+1,height)-top;
  await pixels.crop({x:left,y:top,size:{width:cropWidth,height:cropHeight}});const scale=p.targetSize/Math.max(cropWidth,cropHeight);await pixels.scale(scale,scale);
  const resized=await pixels.getImageInfo(),rw=resized.size.width,rh=resized.size.height;if(rw>p.targetSize||rh>p.targetSize||rw<1||rh<1)throw Error('CROP_RESIZE_INVALID');
  const raw=new Uint8Array(rw*rh*4);await pixels.readPixelsToBuffer(raw.buffer as ArrayBuffer);
  const padded=new Uint8Array(p.targetSize*p.targetSize*4);for(let i=0;i<padded.length;i+=4){padded[i]=245;padded[i+1]=245;padded[i+2]=245;padded[i+3]=255;}
  const x=Math.floor((p.targetSize-rw)/2),y=Math.floor((p.targetSize-rh)/2);for(let row=0;row<rh;row++)padded.set(raw.subarray(row*rw*4,(row+1)*rw*4),((row+y)*p.targetSize+x)*4);
  canvas=await image.createPixelMap(padded.buffer as ArrayBuffer,{size:{width:p.targetSize,height:p.targetSize},srcPixelFormat:image.PixelMapFormat.RGBA_8888,pixelFormat:image.PixelMapFormat.RGBA_8888,editable:false,alphaType:image.AlphaType.OPAQUE});
  return new Uint8Array(await packer.packing(canvas,{format:'image/jpeg',quality:p.jpegQuality}));
 }finally{await canvas?.release();await pixels?.release();await packer.release();await source.release();}
}
