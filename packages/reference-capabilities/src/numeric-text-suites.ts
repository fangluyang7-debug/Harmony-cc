import type {ReferenceCase,ReferencePack} from './index';
import {frozenPack,propertyPack} from './evaluation';

const config={id:'standard',threads:1,batchSize:1,quality:'standard'};
function example(id:string,input:Buffer,covers:string[],expected?:unknown,errorCode?:string):ReferenceCase{
  return {id,input,config,parameters:'{}',maxOutputBytes:4096,covers,expected,expect:errorCode?{kind:'REJECT',errorCode}:{kind:'OUTPUT'}};
}
function count(text:string){
  let characters=0;for(const _ of text)characters++;
  const words=text.match(/\S+/gu)?.length??0,lines=text===''?0:1+(text.match(/\r\n|\r|\n/gu)?.length??0);
  return {characters,words,lines};
}
export function textReferences(pack:Pick<ReferencePack,'manifest'|'maxOutputBytes'>):ReferencePack{
  const input=(text:string)=>Buffer.from(JSON.stringify({text}));
  const schema='schema:text.input';
  const values:[string,string,string[]][]=[['reference','Hello Harmony\n资源协同',[schema]],['empty','',['boundary:empty']],['unicode','你😀e\u0301',['unicode:grapheme']],['crlf','a\r\nb',['boundary:line-ending']]];
  const cases=values.map(([id,text,tags])=>example(id,input(text),[...new Set([schema,...tags])],count(text)));
  // Pair small cases only. The upper-bound case cannot be concatenated within the wire limit.
  const bases=['','a\r','你😀'];
  for(const [i,a] of bases.entries())for(const [j,b] of bases.entries()){
    const left=count(a),right=count(b),joined=a+'\n'+b;
    const expected={characters:left.characters+right.characters+1,words:left.words+right.words,
      lines:a.length&&b.length&&!a.endsWith('\r')?left.lines+right.lines:count(joined).lines};
    cases.push(example('join-'+i+'-'+j,input(joined),[schema],expected));
  }
  const max='a'.repeat(8388608-input('').length);
  cases.push(example('max',input(max),[schema,'boundary:max'],{characters:max.length,words:1,lines:1}),
    example('invalid',Buffer.from('not json'),[schema],undefined,'TEXT_INVALID'));
  return {...pack,cases,evaluate:async(c,output)=>frozenPack((test:ReferenceCase)=>test.expected)(c,JSON.parse(output.toString()))};
}
interface Vector {dimension:number;rows:number[][]}
interface Normalized extends Vector {norms:number[];}
const vectorRules=[
  {id:'shape',version:1,check:(v:Vector,o:Normalized)=>o.dimension===v.dimension&&o.rows.length===v.rows.length&&o.norms.length===v.rows.length&&o.rows.every(r=>r.length===v.dimension)},
  {id:'norms',version:1,check:(v:Vector,o:Normalized)=>v.rows.every((r,i)=>Math.abs(o.norms[i]-Math.hypot(...r))<=1e-10*Math.max(1,Math.hypot(...r)))},
  {id:'direction',version:1,check:(v:Vector,o:Normalized)=>v.rows.every((r,i)=>{const n=Math.hypot(...r);return Math.abs(Math.hypot(...o.rows[i])-(n?1:0))<1e-10&&r.every((x,j)=>Math.abs(o.rows[i][j]-(n?x/n:0))<1e-10);})}
];
const scoreVector=propertyPack(vectorRules);
export function vectorReferences(pack:Pick<ReferencePack,'manifest'|'maxOutputBytes'>):ReferencePack{
  const schema='schema:vector.input';
  const make=(id:string,v:Vector,tags:string[])=>example(id,Buffer.from(JSON.stringify(v)),[schema,...tags],{invariants:vectorRules.map(({id,version})=>({id,version}))});
  const cases=[make('reference',{dimension:2,rows:[[3,4],[0,0]]},['float:zero']),make('empty',{dimension:1,rows:[]},['boundary:empty']),
    make('max',{dimension:65536,rows:[]},['boundary:max']),make('large',{dimension:2,rows:[[1e200,-1e200]]},['float:large']),
    example('invalid',Buffer.from('{"dimension":2,"rows":[[0]]}'),[schema],undefined,'VECTOR_INVALID')];
  return {...pack,cases,evaluate:async(c,bytes)=>scoreVector(JSON.parse(c.input.toString()),JSON.parse(bytes.toString()))};
}
