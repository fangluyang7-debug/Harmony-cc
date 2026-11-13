export interface PhotoTile {index:number;x:number;y:number;width:number;height:number;left:number;top:number;inputWidth:number;inputHeight:number;}
/** Original pixel coordinates. Only overlapping borders are discarded after x4 inference. */
export function photoTiles(width:number,height:number):PhotoTile[]{
 if(![width,height].every((v:number)=>Number.isSafeInteger(v)&&v>0&&v<=32768))throw Error('PHOTO_GEOMETRY_INVALID');
 const out:PhotoTile[]=[];
 for(let y=0;y<height;y+=256)for(let x=0;x<width;x+=256){const w=Math.min(256,width-x),h=Math.min(256,height-y),left=Math.max(0,x-16),top=Math.max(0,y-16);out.push({index:out.length,x,y,width:w,height:h,left,top,inputWidth:Math.min(width,x+w+16)-left,inputHeight:Math.min(height,y+h+16)-top});}
 return out;
}
