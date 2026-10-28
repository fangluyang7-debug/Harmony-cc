import { TaskContractV1 } from '../../../core/runtime/scheduling-protocol';

/** Shared by apps using this capability; request-specific crop coordinates are not cost classes. */
export const IMAGE_CROP_CONTRACT:TaskContractV1={
  protocolVersion:1,contractId:'image.crop',version:1,capability:'image.crop.v1',
  inputSchemas:['shopping.image'],outputSchemas:['shopping.image'],restartable:true,
  preemptionBoundary:'NONE',checkpointFormats:[],sideEffectPolicy:'PURE',maxAttempts:1,
  costModel:{version:'crop-size-quality-v1',parameters:[{name:'targetSize'},{name:'jpegQuality',bucketWidth:10}]}
};
