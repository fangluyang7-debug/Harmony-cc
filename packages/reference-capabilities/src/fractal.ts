import {createHash} from 'node:crypto';
import type {ReferencePack,ReferenceCase} from './index';
export interface Region {width:number;height:number;canvasWidth:number;canvasHeight:number;offsetX:number;offsetY:number;xMin:number;xMax:number;yMin:number;yMax:number;iterations:number;}
// Independent reference: no executor imports and no cardioid shortcut.
export function referenceFractal(r:Region):Buffer {
 const out=Buffer.alloc(12+3*r.width*r.height);out.write('HRGB');out.writeUInt32LE(r.width,4);out.writeUInt32LE(r.height,8);
 for(let row=0;row<r.height;row++)for(let col=0;col<r.width;col++){
  const a=r.xMin+(col+r.offsetX+.5)/r.canvasWidth*(r.xMax-r.xMin),b=r.yMin+(row+r.offsetY+.5)/r.canvasHeight*(r.yMax-r.yMin);
  let zr=0,zi=0,k=0;while(zr*zr+zi*zi<=4&&k<r.iterations){const real=zr*zr-zi*zi+a;zi=2*zr*zi+b;zr=real;k++;}
  if(k<r.iterations){const i=12+3*(row*r.width+col);out[i]=k*9%256;out[i+1]=k*7%256;out[i+2]=k*5%256;}
 }return out;
}
export function validRenderedTile(b:Buffer):boolean {return b.length>=15&&b.subarray(0,4).toString()==='HRGB'&&b.readUInt32LE(4)>=1&&b.readUInt32LE(4)<=512&&b.readUInt32LE(8)>=1&&b.readUInt32LE(8)<=512&&b.length===12+b.readUInt32LE(4)*b.readUInt32LE(8)*3;}
export function fractalPack():ReferencePack {
 const base:Region={width:2,height:2,canvasWidth:2,canvasHeight:2,offsetX:0,offsetY:0,xMin:-2,xMax:2,yMin:-2,yMax:2,iterations:32};
 const make=(id:string,r:Region,tags:string[]):ReferenceCase=>({id,input:Buffer.from(JSON.stringify(r)),config:{id:'standard',threads:1,batchSize:1,quality:'standard'},parameters:JSON.stringify({width:r.width,height:r.height,iterations:r.iterations,regionKey:createHash('sha256').update(JSON.stringify(r)).digest('hex')}),maxOutputBytes:12+r.width*r.height*3,covers:['schema:render.region',...tags],expected:referenceFractal(r).toString('base64'),expect:{kind:'OUTPUT'}});
 const cases=[make('known',base,[]),make('offset',{...base,width:1,height:1,offsetX:1,offsetY:1},['param:width:min','param:height:min']),
  make('minimum',{...base,width:1,height:1,iterations:1},['param:iterations:min']),
  make('maximum-width',{...base,width:512,height:1,canvasWidth:512,canvasHeight:1,xMin:2,xMax:3,yMin:2,yMax:3,iterations:8192},['boundary:max','param:width:max','param:iterations:max']),
  make('maximum-height',{...base,width:1,height:512,canvasWidth:1,canvasHeight:512,xMin:2,xMax:3,yMin:2,yMax:3,iterations:8192},['param:height:max']),
  make('boundary-detail',{...base,width:64,height:64,canvasWidth:64,canvasHeight:64,xMin:-.748,xMax:-.744,yMin:.126,yMax:.130,iterations:1024},[]),
  {id:'invalid',input:Buffer.from('{}'),config:{id:'standard',threads:1,batchSize:1,quality:'standard'},parameters:'{}',maxOutputBytes:65536,covers:['schema:render.region','boundary:empty'],expect:{kind:'REJECT' as const,errorCode:'FRACTAL_INVALID'}}];
 for(const [id,regionKey,bound] of [['key-empty','','min'],['key-long','0'.repeat(65),'max']]){
  const c=make(id,base,['param:regionKey:'+bound]);c.parameters=JSON.stringify({...JSON.parse(c.parameters),regionKey});c.expect={kind:'REJECT',errorCode:'FRACTAL_INVALID'};cases.push(c);
 }
 return {manifest:{packId:'render.fractal.v1',contract:{contractId:'render.fractal.v1',version:1,capability:'render.fractal.v1',inputSchemas:['render.region'],outputSchemas:['render.rgb'],sideEffectPolicy:'PURE',interruptibility:'CANCEL_RESTART',maxNonPreemptibleMs:null,workModel:{version:'fractal-cost-v2',parameters:[{name:'regionKey'},{name:'width'},{name:'height'},{name:'iterations',bucketWidth:256}]}},executorIds:['node.cpu.v1','harmony.cpu.v1'],model:null,suiteId:'render.fractal.reference',qualityThreshold:1,resourceLimit:[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:67108864}]},cases,maxOutputBytes:786444,evaluate:async(test,output)=>validRenderedTile(output)&&output.equals(Buffer.from(test.expected as string,'base64'))?1:0};
}
