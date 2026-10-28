import { TaskContractV1 } from '../runtime/scheduling-protocol';

/** Shared by apps using this capability; request-specific crop coordinates are not cost classes. */
export const IMAGE_CROP_CONTRACT:TaskContractV1={
  protocolVersion:1,contractId:'image.crop',version:2,capability:'image.crop.v1',
  inputSchemas:['image.raster.v1'],outputSchemas:['image.raster.v1'],restartable:true,
  preemptionBoundary:'NONE',checkpointFormats:[],sideEffectPolicy:'PURE',maxAttempts:1,
  costModel:{version:'crop-size-quality-v1',parameters:[{name:'targetSize'},{name:'jpegQuality',bucketWidth:10}]}
};
