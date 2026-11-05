import type {CpuExecutor} from './registry';

export const execute:CpuExecutor=async(bytes,parameters,config)=>{
  let v;try{v=JSON.parse(bytes.toString('utf8'));}catch{throw Error('TEXT_INVALID');}
  if(!v||Object.keys(v).join('|')!=='text'||typeof v.text!=='string')throw Error('TEXT_INVALID');
  let characters=0;for(const _ of v.text)characters++;
  return {output:Buffer.from(JSON.stringify({characters,words:v.text.trim()?v.text.trim().split(/\s+/u).length:0,lines:v.text.length?v.text.split(/\r\n|\r|\n/u).length:0})),schemaId:'text.counts'};
};
