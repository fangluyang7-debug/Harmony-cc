export interface ImageCropResult {
  buffer: Buffer;
  metadata: {
    width: number;
    height: number;
    format: string | null;
  };
  cropRegionPx: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  strategy: string;
}
