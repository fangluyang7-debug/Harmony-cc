import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { base64 } from 'scheduler';
import { photoSession } from './PhotoSession';
import { PhotoResult, storePhotoResult } from './PhotoFiles';

export class PhotoBridge {
 private context:()=>common.UIAbilityContext;
 private caller:()=>string;
 private onResult:(result:PhotoResult)=>void;
 constructor(context:()=>common.UIAbilityContext,caller:()=>string,onResult:(result:PhotoResult)=>void){this.context=context;this.caller=caller;this.onResult=onResult;}
 private check():void{const c=photoSession.connection();if(c===null||!this.caller().startsWith(c.address+'/photo-mobile.html?'))throw Error('PHOTO_PAGE_SCOPE');}
 async info():Promise<string>{this.check();return JSON.stringify(photoSession.connection());}
 async request(encoded:string):Promise<string>{this.check();return photoSession.request('/v2/apps/photo',encoded);}
 async sdkRequest(route:string,body:string):Promise<string>{this.check();return photoSession.sdkRequest(route,body===''?null:body);}
 async sdkWrite(ticket:string,data:string):Promise<void>{this.check();return photoSession.write(ticket,data);}
 async sdkRead(ticket:string):Promise<string>{this.check();return photoSession.read(ticket);}
 async stageResult(encoded:string,name:string):Promise<void>{this.check();const result=await storePhotoResult(this.context(),encoded,name);this.onResult(result);}
 async pickPhoto():Promise<string>{
  this.check();const picker=new photoAccessHelper.PhotoViewPicker(),selected=await picker.select({MIMEType:photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE,maxSelectNumber:1});
  if(!selected.photoUris.length)return JSON.stringify({data:''});
  const f=fileIo.openSync(selected.photoUris[0],fileIo.OpenMode.READ_ONLY);
  try{const size=fileIo.statSync(f.fd).size;if(size<1||size>8388608)throw Error('照片不能超过 8 MiB');const bytes=new ArrayBuffer(size);if(fileIo.readSync(f.fd,bytes)!==size)throw Error('PHOTO_READ_INCOMPLETE');return JSON.stringify({name:'selected-photo.jpg',mime:'image/jpeg',data:base64.encodeToStringSync(new Uint8Array(bytes))});}finally{fileIo.closeSync(f);}
 }
}
