/** Conservative PNG+JSON byte bounds, not timings. Executors validate declared geometry. */
export function photoOutputBound(capability:string,parameters:string,fallback:number):number{
 if(!capability.startsWith('photo.'))return fallback;
 try{
  const p=JSON.parse(parameters);let w=p.width,h=p.height;
  if(!Number.isSafeInteger(w)||!Number.isSafeInteger(h)||w<1||h<1||w*h>16777216)return fallback;
  if(capability==='photo.prepare.v1'){w+=32;h+=32;}
  if(['photo.enhance.v1','photo.assemble.v1'].includes(capability)){w*=4;h*=4;}
  const raw=w*h*4+h,png=raw+Math.ceil(raw/16384)*6+4096;
  const bound=capability==='photo.assemble.v1'?png:Math.ceil(png/3)*4+2048+(capability==='photo.deliver.v1'?Math.min(w,480)*Math.min(h,360)*4+4096:0);
  return Math.min(8388608,bound);
 }catch{return fallback;}
}
