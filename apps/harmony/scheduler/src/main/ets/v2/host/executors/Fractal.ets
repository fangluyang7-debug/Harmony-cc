import renderer from 'libharmony_render.so';
import {text,hash,factory} from '../NativePlatform';
import {EngineInput,EngineResult} from './Types';
import {FractalRegion} from './FractalKernel';
interface RenderParameters {regionKey:string;width:number;height:number;iterations:number;}
export async function execute(request:EngineInput):Promise<EngineResult>{
 const encoded=text(request.input),region=JSON.parse(encoded) as FractalRegion,p=JSON.parse(request.parameters) as RenderParameters;
 if(!region||Object.keys(region).sort().join('|')!=='canvasHeight|canvasWidth|height|iterations|offsetX|offsetY|width|xMax|xMin|yMax|yMin'||
  ![region.width,region.height,region.canvasWidth,region.canvasHeight,region.offsetX,region.offsetY,region.iterations].every(Number.isSafeInteger)||
  region.width<1||region.width>512||region.height<1||region.height>512||region.canvasWidth<region.width||region.canvasWidth>4096||region.canvasHeight<region.height||region.canvasHeight>4096||
  region.offsetX<0||region.offsetY<0||region.offsetX+region.width>region.canvasWidth||region.offsetY+region.height>region.canvasHeight||region.iterations<1||region.iterations>8192||
  ![region.xMin,region.xMax,region.yMin,region.yMax].every(Number.isFinite)||region.xMin>=region.xMax||region.yMin>=region.yMax||Math.max(Math.abs(region.xMin),Math.abs(region.xMax),Math.abs(region.yMin),Math.abs(region.yMax))>4)throw Error('FRACTAL_INVALID');
 if(p.regionKey!==hash(request.input)||p.iterations!==region.iterations||p.width!==region.width||p.height!==region.height)throw Error('FRACTAL_INVALID');
 const id=factory.id();let cancelling=false;
 const timer=setInterval(()=>{if(!cancelling&&request.cancelled()){cancelling=true;renderer.cancel(id);}},50);
 try{return {data:new Uint8Array(await renderer.render(id,[region.width,region.height,region.canvasWidth,region.canvasHeight,region.offsetX,region.offsetY,region.xMin,region.xMax,region.yMin,region.yMax,region.iterations])),schemaId:'render.rgb'};}
 finally{clearInterval(timer);}
}
