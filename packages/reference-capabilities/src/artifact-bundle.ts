import {createHash} from 'node:crypto';
export interface BundlePart {nodeId:string;schemaId:string;contentHash:string;bytes:number;data:string;}
export function encodeBundle(parts:{nodeId:string;schemaId:string;data:Buffer}[]):Buffer {
 const bytes=Buffer.from(JSON.stringify({version:1,parts:parts.map(p=>({nodeId:p.nodeId,schemaId:p.schemaId,contentHash:createHash('sha256').update(p.data).digest('hex'),bytes:p.data.length,data:p.data.toString('base64')}))}));
 if(bytes.length>8388608)throw Error('GRAPH_BUNDLE_TOO_LARGE');decodeBundle(bytes);return bytes;
}
export function decodeBundle(bytes:Buffer):BundlePart[]{
 if(bytes.length>8388608)throw Error('GRAPH_BUNDLE_TOO_LARGE');const value=JSON.parse(bytes.toString());if(value.version!==1||!Array.isArray(value.parts)||!value.parts.length||value.parts.length>32)throw Error('GRAPH_BUNDLE_INVALID');
 const seen=new Set<string>();for(const p of value.parts){
  if(typeof p.nodeId!=='string'||seen.has(p.nodeId)||typeof p.schemaId!=='string'||typeof p.data!=='string')throw Error('GRAPH_BUNDLE_INVALID');
  const b=Buffer.from(p.data,'base64');if(b.toString('base64')!==p.data||b.length!==p.bytes||createHash('sha256').update(b).digest('hex')!==p.contentHash)throw Error('GRAPH_BUNDLE_HASH');seen.add(p.nodeId);
 }return value.parts;
}
