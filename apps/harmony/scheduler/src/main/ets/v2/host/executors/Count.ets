import {bytes,text} from '../NativePlatform';
import {EngineInput,EngineResult} from './Types';
interface TextInput {text:string;}
interface TextOutput {characters:number;words:number;lines:number;}
function characters(value:string):number {
  let count=0;
  for(let i=0;i<value.length;count++)i+=(value.codePointAt(i)??0)>0xffff?2:1;
  return count;
}
export async function execute(request:EngineInput):Promise<EngineResult>{
  const input=request.input;
  let v:TextInput;try{v=JSON.parse(text(input)) as TextInput;}catch{throw Error('TEXT_INVALID');}if(!v||Object.keys(v).join('|')!=='text'||typeof v.text!=='string')throw Error('TEXT_INVALID');const output:TextOutput={characters:characters(v.text),words:v.text.trim()?v.text.trim().split(/\s+/u).length:0,lines:v.text.length?v.text.split(/\r\n|\r|\n/u).length:0};return {data:bytes(JSON.stringify(output)),schemaId:'text.counts'};
}
