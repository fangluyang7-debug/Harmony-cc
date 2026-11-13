export interface CoordinatorHttpRequest {keepAlive?:boolean;method:string;path:string;authorization:string;body:Uint8Array;deviceCredential?:string;remoteAddress?:string;webSocketKey?:string;displayKey?:string;origin?:string;displayReset?:string;}
/** Bounded HTTP/1.1 framing; artifact bodies remain bytes throughout the transport. */
export class CoordinatorHttpParser {
 private header:Uint8Array=new Uint8Array(16388);
 private headerBytes:number=0;
 private request:CoordinatorHttpRequest|null=null;
 private received:number=0;
 private complete:boolean=false;
 push(chunk:Uint8Array):CoordinatorHttpRequest|null {
  if(this.complete)throw Error('HTTP_PIPELINING_UNSUPPORTED');
  let offset=0;
  if(this.request===null){
   while(offset<chunk.length){
    if(this.headerBytes===this.header.length)throw Error('HTTP_HEADERS_TOO_LARGE');
    this.header[this.headerBytes++]=chunk[offset++];
    const n=this.headerBytes;
    if(n>=4&&this.header[n-4]===13&&this.header[n-3]===10&&this.header[n-2]===13&&this.header[n-1]===10){this.request=this.parseHeader(this.header,n-4);break;}
    // Allow at most the CRLF delimiter beyond the header limit.
    if(n>16384&&this.header[n-1]!==13&&this.header[n-1]!==10)throw Error('HTTP_HEADERS_TOO_LARGE');
   }
   if(this.request===null)return null;
  }
  const request=this.request,remaining=chunk.length-offset;
  if(this.received+remaining>request.body.length)throw Error('HTTP_PIPELINING_UNSUPPORTED');
  request.body.set(chunk.subarray(offset),this.received);this.received+=remaining;
  if(this.received!==request.body.length)return null;
  this.complete=true;return request;
 }
 private parseHeader(next:Uint8Array,end:number):CoordinatorHttpRequest {
  if(end>16384)throw Error('HTTP_HEADERS_TOO_LARGE');
  let header='';for(let i=0;i<end;i++){if(next[i]>127||next[i]===0)throw Error('HTTP_HEADER_INVALID');header+=String.fromCharCode(next[i]);}
  const lines=header.split('\r\n'),first=lines.shift()!.split(' ');
  if(first.length!==3||!['GET','POST','PUT','DELETE','OPTIONS'].includes(first[0])||first[2]!=='HTTP/1.1'||!first[1].startsWith('/'))throw Error('HTTP_REQUEST_INVALID');
  const headers=new Map<string,string>();
  for(const line of lines){const colon=line.indexOf(':');if(colon<1||/^[ \t]/.test(line))throw Error('HTTP_HEADER_INVALID');const key=line.slice(0,colon).toLowerCase();if(!/^[a-z0-9-]+$/.test(key)||headers.has(key))throw Error('HTTP_HEADER_INVALID');headers.set(key,line.slice(colon+1).trim());}
  if(headers.has('transfer-encoding'))throw Error('HTTP_TRANSFER_ENCODING_UNSUPPORTED');
  const raw=headers.get('content-length')??'0';if(!/^\d+$/.test(raw))throw Error('HTTP_LENGTH_INVALID');const length=Number(raw);
  const limit=first[0]==='POST'&&['/v2/apps/photo','/event'].includes(first[1])?12000000:first[0]==='PUT'&&/^\/v2\/artifacts\/[A-Za-z0-9_.:-]+\/[1-9][0-9]*$/.test(first[1])?8388608:1048576;
  if(!Number.isSafeInteger(length)||length>limit)throw Error('HTTP_REQUEST_TOO_LARGE');
  const request:CoordinatorHttpRequest={method:first[0],path:first[1],authorization:headers.get('authorization')??'',body:new Uint8Array(length),keepAlive:!headers.get('connection')?.toLowerCase().split(',').map(v=>v.trim()).includes('close')};
  const credential=headers.get('x-device-credential');if(credential!==undefined)request.deviceCredential=credential;
  request.displayKey=headers.get('x-display-key');request.origin=headers.get('origin');request.displayReset=headers.get('x-display-reset');
  if(headers.has('upgrade')){
   const key=headers.get('sec-websocket-key')??'';
   if(first[0]!=='GET'||length!==0||headers.get('upgrade')?.toLowerCase()!=='websocket'||
     !headers.get('connection')?.toLowerCase().split(',').map(v=>v.trim()).includes('upgrade')||headers.get('sec-websocket-version')!=='13'||
     !/^[A-Za-z0-9+/]{22}==$/.test(key))throw Error('WS_HANDSHAKE_INVALID');
   request.webSocketKey=key;
  }
  return request;
 }
}
