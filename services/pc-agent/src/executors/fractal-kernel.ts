export interface FractalRegion {width:number;height:number;canvasWidth:number;canvasHeight:number;offsetX:number;offsetY:number;xMin:number;xMax:number;yMin:number;yMax:number;iterations:number;}
export function renderRegion(encoded:string):ArrayBuffer {
 const r=JSON.parse(encoded) as FractalRegion;
 if(!r||Object.keys(r).sort().join('|')!=='canvasHeight|canvasWidth|height|iterations|offsetX|offsetY|width|xMax|xMin|yMax|yMin'||
  ![r.width,r.height,r.canvasWidth,r.canvasHeight,r.offsetX,r.offsetY,r.iterations].every(Number.isSafeInteger)||
  r.width<1||r.width>512||r.height<1||r.height>512||r.canvasWidth<r.width||r.canvasWidth>4096||r.canvasHeight<r.height||r.canvasHeight>4096||
  r.offsetX<0||r.offsetY<0||r.offsetX+r.width>r.canvasWidth||r.offsetY+r.height>r.canvasHeight||r.iterations<1||r.iterations>8192||
  ![r.xMin,r.xMax,r.yMin,r.yMax].every(Number.isFinite)||r.xMin>=r.xMax||r.yMin>=r.yMax||Math.max(Math.abs(r.xMin),Math.abs(r.xMax),Math.abs(r.yMin),Math.abs(r.yMax))>4)throw Error('FRACTAL_INVALID');
 const out=new Uint8Array(12+r.width*r.height*3),header=new DataView(out.buffer);out.set([72,82,71,66]);header.setUint32(4,r.width,true);header.setUint32(8,r.height,true);
 for(let y=0;y<r.height;y++)for(let x=0;x<r.width;x++){
  const cr=r.xMin+(r.offsetX+x+0.5)/r.canvasWidth*(r.xMax-r.xMin),ci=r.yMin+(r.offsetY+y+0.5)/r.canvasHeight*(r.yMax-r.yMin);
  const q=(cr-.25)*(cr-.25)+ci*ci;let n=0;
  if(q*(q+cr-.25)<=.25*ci*ci||(cr+1)*(cr+1)+ci*ci<=.0625)n=r.iterations;
  else{let re=0,im=0;while(re*re+im*im<=4&&n<r.iterations){const next=re*re-im*im+cr;im=2*re*im+ci;re=next;n++;}}
  const i=12+(y*r.width+x)*3;if(n<r.iterations){out[i]=(n*9)%256;out[i+1]=(n*7)%256;out[i+2]=(n*5)%256;}
 }
 return out.buffer;
}
