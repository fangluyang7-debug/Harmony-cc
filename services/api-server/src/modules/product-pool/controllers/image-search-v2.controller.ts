import { Body, Controller, Get, HttpCode, HttpException, Param, Post, UseGuards } from '@nestjs/common';
import { ModelManifestV2, sameModelV2, validModelManifestV2 } from '@harmony/scheduler-core';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { loadIndex, rank, validQueryVector } from '../application/image-search-index';
import { LocalImageWorkerClientService } from '../application/local-image-worker-client.service';

interface SearchRequest {
  requestId: string; indexSpaceId: string; model: ModelManifestV2; topK: number;
  filters?: {category?: string}; vector?: number[]; imageBase64?: string;
}
function fail(code: string, status: number): never { throw new HttpException({code},status); }

@Controller('api/v2/image-search')
@UseGuards(JwtAuthGuard)
export class ImageSearchV2Controller {
  constructor(private readonly worker: LocalImageWorkerClientService) {}
  @Get('spaces/:space')
  async activeSpace(@Param('space') space: string) {
    const index=await this.index(space);
    return {indexSpaceId:index.indexSpaceId,indexVersion:index.version,model:index.model};
  }
  @Post('vector') @HttpCode(200)
  vector(@Body() body: SearchRequest) { return this.search(body,false); }
  @Post('image') @HttpCode(200)
  image(@Body() body: SearchRequest) { return this.search(body,true); }
  private async search(body: SearchRequest, image: boolean) {
    const start=performance.now();
    if (!body || !validModelManifestV2(body.model) || typeof body.requestId !== 'string' ||
        !body.requestId.length || body.requestId.length>128 || !Number.isInteger(body.topK) ||
        body.topK<1 || body.topK>100 || (body.filters !== undefined && (!body.filters || typeof body.filters !== 'object' ||
        Array.isArray(body.filters) || Object.keys(body.filters).some(k=>k!=='category') ||
        (body.filters.category !== undefined && typeof body.filters.category !== 'string')))) fail('IMAGE_V2_INPUT_INVALID',400);
    const index=await this.index(body.indexSpaceId,body.model);
    let vector=body.vector;
    if (image) {
      if (vector!==undefined || typeof body.imageBase64!=='string' || !body.imageBase64.length ||
          body.imageBase64.length>8*1024*1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.imageBase64)) fail('IMAGE_V2_INPUT_INVALID',400);
      const encoded=await this.worker.post<{model:ModelManifestV2;vector:number[]}>('/v2/images/embed',{imageBase64:body.imageBase64})
        .catch(()=>fail('IMAGE_V2_ENCODER_UNAVAILABLE',503));
      if (!encoded || !validModelManifestV2(encoded.model) || !sameModelV2(index.model,encoded.model)) fail('IMAGE_V2_MODEL_MISMATCH',409);
      vector=encoded.vector;
    } else if (body.imageBase64!==undefined) fail('IMAGE_V2_INPUT_INVALID',400);
    if (!validQueryVector(vector,index.model.dimension)) fail(image?'IMAGE_V2_ENCODER_INVALID':'IMAGE_V2_INPUT_INVALID',image?502:400);
    return {requestId:body.requestId,indexSpaceId:index.indexSpaceId,indexVersion:index.version,model:index.model,
      candidates:rank(index,vector,body.topK,body.filters?.category),scoreMeaning:'COSINE_SIMILARITY',nextPage:null,processingMs:performance.now()-start};
  }
  private async index(space:string, model?: ModelManifestV2) {
    const root=process.env.SOLEAI_IMAGE_INDEX_DIR;
    if (!root) fail('IMAGE_V2_INDEX_UNAVAILABLE',503);
    return loadIndex(root,space,model).catch(err=>{
      const code=err.message;
      return fail(code,code==='IMAGE_V2_MODEL_MISMATCH'?409:code==='IMAGE_V2_INPUT_INVALID'?400:503);
    });
  }
}
