/** Concurrent GPU job lifecycles (load/compute/publish), NOT physical GPU count.
 * The executor must opt in and still account RAM/VRAM per admitted job. */
export function gpuPipelineSlots(vramBytes:number):number {
  if(!Number.isSafeInteger(vramBytes)||vramBytes<=0)return 1;
  return Math.max(1,Math.min(4,Math.floor(vramBytes/1073741824)));
}
