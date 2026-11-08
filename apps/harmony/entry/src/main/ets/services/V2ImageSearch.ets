import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { fileIo } from '@kit.CoreFileKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { ModelManifestV2, SchedulerSdk, SdkWorkflow, sameModelV2, validModelManifestV2 } from 'scheduler';
import { CloudApiConfig } from './CloudApiConfig';

interface Space { indexSpaceId:string; indexVersion:string; model:ModelManifestV2; }
export interface Candidate { productId:string; score:number; }
export interface SearchResult extends Space { requestId:string; candidates:Candidate[]; processingMs:number; encodingTargetId?:string; }
interface SearchBody {requestId:string;indexSpaceId:string;model:ModelManifestV2;topK:number;imageBase64?:string;vector?:number[];}
interface EncodedImage {model:ModelManifestV2;vector:number[];}
export interface EncodingTarget {sdk:SchedulerSdk;targetId?:string;}
interface ErrorBody {code:string;}
interface Failure {error?:ErrorBody;}

async function request(origin:string,path:string,body?:SearchBody):Promise<string> {
  if(origin!==CloudApiConfig.getBaseUrl())throw Error('CLOUD_ORIGIN_CHANGED');
  const client=http.createHttp();
  try {
    const response=await client.request(origin+'/api/v2/image-search/'+path,{
      method:body===undefined?http.RequestMethod.GET:http.RequestMethod.POST,
      header:CloudApiConfig.requestHeaders(),extraData:body===undefined?'':JSON.stringify(body),
      connectTimeout:10000,readTimeout:90000
    });
    if(typeof response.result!=='string')throw Error('IMAGE_V2_RESPONSE_INVALID');
    if(response.responseCode!==200){
      const failure=JSON.parse(response.result) as Failure;
      throw Error(failure.error?.code??('HTTP_'+response.responseCode));
    }
    return response.result;
  }finally{client.destroy();}
}
export async function searchSelectedImage(spaceId:string,encoding?:EncodingTarget):Promise<SearchResult|null> {
  if(!/^[a-z0-9][a-z0-9_-]{0,95}$/.test(spaceId))throw Error('请填写有效的索引空间 ID');
  const picker=new photoAccessHelper.PhotoViewPicker();
  const selection=await picker.select({MIMEType:photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE,maxSelectNumber:1});
  if(selection.photoUris.length===0)return null;
  const file=fileIo.openSync(selection.photoUris[0],fileIo.OpenMode.READ_ONLY);
  let bytes:Uint8Array;
  try{
    const size=fileIo.statSync(file.fd).size;
    if(size<1||size>6*1024*1024)throw Error('图片大小需在 6 MiB 以内');
    const buffer=new ArrayBuffer(size);
    if(fileIo.readSync(file.fd,buffer)!==size)throw Error('FILE_READ_INCOMPLETE');
    bytes=new Uint8Array(buffer);
  }finally{fileIo.closeSync(file);}
  const origin=CloudApiConfig.getBaseUrl();
  await CloudApiConfig.ensureGuest();
  const space=JSON.parse(await request(origin,'spaces/'+spaceId)) as Space;
  if(space.indexSpaceId!==spaceId||!space.model||!validModelManifestV2(space.model))throw Error('IMAGE_V2_SPACE_INVALID');
  const id=util.generateRandomUUID(true);
  const body:SearchBody={requestId:id,indexSpaceId:spaceId,model:space.model,topK:10};
  let path='image';
  let encodingTargetId:string|undefined=undefined;
  if(encoding){
    const input=await encoding.sdk.registerInput(bytes,'image.raster');
    try{
      const workflow:SdkWorkflow={version:3,id,outputContract:'image.embedding',qualityTarget:'reference',
        nodes:[{id:'encode',capability:'image.encode.v1',modelManifest:space.model,targetId:encoding.targetId||undefined,input,dependsOn:[],parameters:JSON.stringify(space.model)}]};
      const task=await encoding.sdk.submit(workflow,{requestId:id,budgetMs:30000,resultDestination:'ORIGIN'});
      const result=await task.result();
      if(!result.status.targetId||(encoding.targetId&&result.status.targetId!==encoding.targetId))throw Error('IMAGE_V2_TARGET_MISMATCH');
      encodingTargetId=result.status.targetId;
      const encoded=JSON.parse(new util.TextDecoder('utf-8').decodeToString(result.output)) as EncodedImage;
      if(!encoded.model||!sameModelV2(space.model,encoded.model))throw Error('IMAGE_V2_MODEL_MISMATCH');
      if(!Array.isArray(encoded.vector)||encoded.vector.length!==space.model.dimension||
        !encoded.vector.every((x:number)=>Number.isFinite(x))||
        Math.abs(encoded.vector.reduce((sum:number,x:number)=>sum+x*x,0)-1)>0.002)throw Error('IMAGE_V2_ENCODER_INVALID');
      body.vector=encoded.vector;path='vector';
    }finally{encoding.sdk.releaseInput(input);}
  }else{body.imageBase64=new util.Base64Helper().encodeToStringSync(bytes);}
  const result=JSON.parse(await request(origin,path,body)) as SearchResult;
  if(result.requestId!==id||result.indexSpaceId!==spaceId||!Array.isArray(result.candidates))throw Error('IMAGE_V2_RESPONSE_INVALID');
  result.encodingTargetId=encodingTargetId;return result;
}
