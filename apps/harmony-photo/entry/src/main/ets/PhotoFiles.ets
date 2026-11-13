import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { image } from '@kit.ImageKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { base64, hash, factory } from 'scheduler';

export interface PhotoResult { id:string; name:string; path:string; width:number; height:number; saved:boolean; }
export interface PhotoInput { id:string; name:string; path:string; width:number; height:number; large?:boolean; }
export function needsPhotoTiles(p:PhotoInput):boolean{return p.large===true||p.width*p.height>1048576||Math.max(p.width,p.height)>1920;}
interface Product { version:number; image:string; hash:string; width:number; height:number; format:string; }
export function readPhoto(path:string):Uint8Array{
 const f=fileIo.openSync(path,fileIo.OpenMode.READ_ONLY);
 try{const size=fileIo.statSync(f.fd).size;if(size<1||!Number.isSafeInteger(size))throw Error('图片文件无效');const b=new ArrayBuffer(size);if(fileIo.readSync(f.fd,b)!==size)throw Error('PHOTO_READ_INCOMPLETE');return new Uint8Array(b);}finally{fileIo.closeSync(f);}
}
function writePhoto(path:string,data:Uint8Array):void{
 const f=fileIo.openSync(path,fileIo.OpenMode.CREATE|fileIo.OpenMode.TRUNC|fileIo.OpenMode.WRITE_ONLY);
 try{const n=fileIo.writeSync(f.fd,data.slice().buffer as ArrayBuffer);if(n!==data.length)throw Error('PHOTO_WRITE_INCOMPLETE');}finally{fileIo.closeSync(f);}
}
async function dimensions(data:Uint8Array):Promise<image.ImageInfo>{const source=image.createImageSource(data.slice().buffer as ArrayBuffer);try{return await source.getImageInfo();}finally{await source.release();}}
export async function pickLocalPhotos(context:common.UIAbilityContext,remaining:number):Promise<PhotoInput[]>{
 const picked=await new photoAccessHelper.PhotoViewPicker().select({MIMEType:photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE,maxSelectNumber:remaining});
 const inputs:PhotoInput[]=[];
 for(const uri of picked.photoUris){const file=fileIo.openSync(uri,fileIo.OpenMode.READ_ONLY),source=image.createImageSource(file.fd);
  try{const info=await source.getImageInfo(),w=info.size.width,h=info.size.height,size=fileIo.statSync(file.fd).size;
   if(!Number.isSafeInteger(w)||!Number.isSafeInteger(h)||w<1||h<1||size<1)throw Error('图片尺寸或文件无效');
   const id=factory.id(),path=context.filesDir+'/photo-input-'+id,target=fileIo.openSync(path,fileIo.OpenMode.CREATE|fileIo.OpenMode.TRUNC|fileIo.OpenMode.WRITE_ONLY);
   try{fileIo.copyFileSync(file.fd,target.fd);}finally{fileIo.closeSync(target);}
   inputs.push({id,name:'照片 '+(inputs.length+1),path,width:w,height:h,large:size>8388608||w*h>1048576||Math.max(w,h)>1920});
  }finally{await source.release();fileIo.closeSync(file);}
 }return inputs;
}
export async function storePhotoResult(context:common.UIAbilityContext,encoded:string,name:string):Promise<PhotoResult>{
 const p=JSON.parse(encoded) as Product;
 if(p.version!==1||p.format!=='png'||typeof p.image!=='string'||p.image.length>12000000)throw Error('PHOTO_RESULT_INVALID');
 const data=base64.decodeSync(p.image);if(hash(data)!==p.hash)throw Error('PHOTO_RESULT_HASH');
 const info=await dimensions(data);if(info.size.width!==p.width||info.size.height!==p.height)throw Error('PHOTO_RESULT_GEOMETRY');
 const path=context.filesDir+'/photo-result-'+p.hash+'.png';writePhoto(path,data);
 return {id:p.hash,name,path,width:p.width,height:p.height,saved:false};
}
/** Called only from a successful native SaveButton click, never from computation. */
export async function savePhotoToAlbum(context:common.UIAbilityContext,result:PhotoResult):Promise<void>{
 const helper=photoAccessHelper.getPhotoAccessHelper(context);
 try{const uri=await helper.createAsset(photoAccessHelper.PhotoType.IMAGE,'png',{title:'Harmony-'+Date.now()});
  const target=fileIo.openSync(uri,fileIo.OpenMode.WRITE_ONLY),source=fileIo.openSync(result.path,fileIo.OpenMode.READ_ONLY);
  try{fileIo.copyFileSync(source.fd,target.fd);}finally{fileIo.closeSync(source);fileIo.closeSync(target);}
 }finally{await helper.release();}
}
