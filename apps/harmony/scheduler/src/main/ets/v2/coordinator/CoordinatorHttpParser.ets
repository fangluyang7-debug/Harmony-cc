export interface CoordinatorHttpRequest {method:string;path:string;authorization:string;body:Uint8Array;remoteAddress?:string;}
/** HTTP/1.1 framing for JSON control requests. Artifact streaming has its own adapter. */
export class CoordinatorHttpParser {
 private data:Uint8Array=new Uint8Array(0);
 push(chunk:Uint8Array):CoordinatorHttpRequest|null {
  if(this.data.length+chunk.length>1048576)throw Error('HTTP_REQUEST_TOO_LARGE');
  const next=new Uint8Array(this.data.length+chunk.length);next.set(this.data);next.set(chunk,this.data.length);this.data=next;
  let end=-1;for(let i=0;i+3<next.length;i++)if(next[i]===13&&next[i+1]===10&&next[i+2]===13&&next[i+3]===10){end=i;break;}
  if(end<0){if(next.length>16384)throw Error('HTTP_HEADERS_TOO_LARGE');return null;}
  if(end>16384)throw Error('HTTP_HEADERS_TOO_LARGE');
  let header='';for(let i=0;i<end;i++){if(next[i]>127||next[i]===0)throw Error('HTTP_HEADER_INVALID');header+=String.fromCharCode(next[i]);}
  const lines=header.split('\r\n'),first=lines.shift()!.split(' ');
  if(first.length!==3||!['GET','POST','PUT','DELETE','OPTIONS'].includes(first[0])||first[2]!=='HTTP/1.1'||!first[1].startsWith('/'))throw Error('HTTP_REQUEST_INVALID');
  const headers=new Map<string,string>();
  for(const line of lines){const colon=line.indexOf(':');if(colon<1||/^[ \t]/.test(line))throw Error('HTTP_HEADER_INVALID');const key=line.slice(0,colon).toLowerCase();if(!/^[a-z0-9-]+$/.test(key)||headers.has(key))throw Error('HTTP_HEADER_INVALID');headers.set(key,line.slice(colon+1).trim());}
  if(headers.has('transfer-encoding'))throw Error('HTTP_TRANSFER_ENCODING_UNSUPPORTED');
  const raw=headers.get('content-length')??'0';if(!/^\d+$/.test(raw))throw Error('HTTP_LENGTH_INVALID');const length=Number(raw);
  if(!Number.isSafeInteger(length)||length>1048576-end-4)throw Error('HTTP_REQUEST_TOO_LARGE');
  if(next.length<end+4+length)return null;
  if(next.length!==end+4+length)throw Error('HTTP_PIPELINING_UNSUPPORTED');
  return {method:first[0],path:first[1],authorization:headers.get('authorization')??'',body:next.slice(end+4)};
 }
}
