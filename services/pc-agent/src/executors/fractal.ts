import {createHash} from 'node:crypto';
import type {CpuExecutor} from './registry';
import {renderRegion,FractalRegion} from './fractal-kernel';
export const execute:CpuExecutor=async(bytes,parameters)=>{
 const encoded=bytes.toString('utf8'),region=JSON.parse(encoded) as FractalRegion;
 if(parameters.regionKey!==createHash('sha256').update(bytes).digest('hex')||parameters.iterations!==region.iterations||parameters.width!==region.width||parameters.height!==region.height)throw Error('FRACTAL_INVALID');
 return {output:Buffer.from(renderRegion(encoded)),schemaId:'render.rgb'};
};
