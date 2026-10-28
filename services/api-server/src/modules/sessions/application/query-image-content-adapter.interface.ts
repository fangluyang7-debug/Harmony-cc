import { ImageCropResult } from '../../../core/capabilities/image-crop-result';
import { NormalizedSubjectBox } from './query-image-preprocess-adapter.interface';

export const QUERY_IMAGE_CONTENT_ADAPTER = Symbol('QUERY_IMAGE_CONTENT_ADAPTER');

export interface QueryImageMetadata {
  width?: number | null;
  height?: number | null;
  format?: string | null;
}

export type QueryImageCropResult = ImageCropResult;

export interface QueryImageContentAdapter {
  readMetadata(signedUrl: string, expectedHash?: string): Promise<QueryImageMetadata>;
  cropForEmbedding(input: {
    signedUrl: string;
    expectedHash?: string;
    box: NormalizedSubjectBox;
    paddingRatio: number;
    targetSize: number;
    jpegQuality: number;
  }): Promise<QueryImageCropResult>;
}
