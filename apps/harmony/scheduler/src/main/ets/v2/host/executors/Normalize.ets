import {bytes,text} from '../NativePlatform';
import {EngineInput,EngineResult} from './Types';
interface VectorInput {dimension:number;rows:number[][];}
interface VectorOutput {dimension:number;rows:number[][];norms:number[];}
export async function execute(request:EngineInput):Promise<EngineResult>{
  const input=request.input;
  const v=JSON.parse(text(input)) as VectorInput;if(!v||Object.keys(v).sort().join('|')!=='dimension|rows'||!Number.isSafeInteger(v.dimension)||v.dimension<1||v.dimension>65536||!Array.isArray(v.rows)||v.rows.length>100000||v.rows.some(r=>!Array.isArray(r)||r.length!==v.dimension||r.some(n=>!Number.isFinite(n))))throw Error('VECTOR_INVALID');const output:VectorOutput={dimension:v.dimension,rows:[],norms:[]};for(const row of v.rows){const norm=Math.hypot(...row);if(!Number.isFinite(norm))throw Error('VECTOR_NORM_INVALID');output.norms.push(norm);output.rows.push(row.map(n=>norm===0?0:n/norm));}return {data:bytes(JSON.stringify(output)),schemaId:'vector.normalized'};
}
