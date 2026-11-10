import path from 'node:path';
import {existsSync} from 'node:fs';
import type {CpuExecutor} from './registry';
export const execute:CpuExecutor=async(input,parameters)=>{
 if(!parameters||Object.keys(parameters).length!==0)throw Error('VISUAL_INVALID');
 const native=(existsSync(path.join(__dirname,'visual.node'))?require('./visual.node'):require('../visual.node')) as {match:(input:Buffer)=>Buffer};
 return {output:native.match(input),schemaId:'image.visual-evidence'};
};
