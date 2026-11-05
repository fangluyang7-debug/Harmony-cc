import type {CpuExecutor} from './registry';

export const execute:CpuExecutor=async(bytes,parameters,config)=>{
  const v=JSON.parse(bytes.toString('utf8'));
  if(!v||Object.keys(v).sort().join('|')!=='dimension|rows'||!Number.isSafeInteger(v.dimension)||v.dimension<1||v.dimension>65536||!Array.isArray(v.rows)||v.rows.length>100000)throw Error('VECTOR_INVALID');
  const rows:number[][]=[],norms:number[]=[];
  for(let i=0;i<v.rows.length;i++){
    const row=v.rows[i];if(!Array.isArray(row)||row.length!==v.dimension||!row.every(Number.isFinite))throw Error('VECTOR_INVALID');
    const norm=Math.hypot(...row);if(!Number.isFinite(norm))throw Error('VECTOR_NORM_INVALID');norms.push(norm);rows.push(row.map((n:number)=>norm===0?0:n/norm));
    if(i%config.batchSize===0)await new Promise(resolve=>setImmediate(resolve));
  }
  return {output:Buffer.from(JSON.stringify({dimension:v.dimension,rows,norms})),schemaId:'vector.normalized'};
};
