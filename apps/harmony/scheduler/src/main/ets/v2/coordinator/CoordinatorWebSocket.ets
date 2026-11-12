export interface CoordinatorWsFrame {opcode:number;payload:Uint8Array;}
/** RFC 6455 server-side framing. Browser/host client frames must be masked. */
export class CoordinatorWebSocketParser {
 private buffer:Uint8Array=new Uint8Array(0);
 private fragments:Uint8Array[]=[];
 private fragmentBytes=0;
 private fragmentOpcode=0;
 push(chunk:Uint8Array):CoordinatorWsFrame[]{
  if(this.buffer.length+chunk.length>524288)throw Error('WS_BUFFER_LIMIT');
  const data=new Uint8Array(this.buffer.length+chunk.length);data.set(this.buffer);data.set(chunk,this.buffer.length);
  let offset=0;const frames:CoordinatorWsFrame[]=[];
  while(data.length-offset>=2){
   const start=offset,first=data[offset++],second=data[offset++],opcode=first&15,final=(first&128)!==0;
   if((first&112)!==0||(second&128)===0||![0,1,2,8,9,10].includes(opcode))throw Error('WS_FRAME_INVALID');
   let length=second&127;
   if(length===126){if(data.length-offset<2){offset=start;break;}length=data[offset]*256+data[offset+1];offset+=2;if(length<126)throw Error('WS_LENGTH_INVALID');}
   else if(length===127){if(data.length-offset<8){offset=start;break;}if(data.slice(offset,offset+4).some(n=>n!==0))throw Error('WS_FRAME_LIMIT');length=data[offset+4]*16777216+data[offset+5]*65536+data[offset+6]*256+data[offset+7];offset+=8;if(length<65536)throw Error('WS_LENGTH_INVALID');}
   if(length>262144)throw Error('WS_FRAME_LIMIT');
   if(opcode>=8&&(!final||length>125||opcode===8&&length===1))throw Error('WS_CONTROL_INVALID');
   if(data.length-offset<length+4){offset=start;break;}
   const mask=data.slice(offset,offset+4);offset+=4;const payload=data.slice(offset,offset+length);offset+=length;
   for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];
   if(opcode>=8){frames.push({opcode,payload});continue;}
   if(opcode===0){if(this.fragmentOpcode===0)throw Error('WS_CONTINUATION_INVALID');}
   else{if(this.fragmentOpcode!==0)throw Error('WS_FRAGMENT_INTERRUPTED');this.fragmentOpcode=opcode;}
   this.fragments.push(payload);this.fragmentBytes+=payload.length;if(this.fragmentBytes>262144)throw Error('WS_MESSAGE_LIMIT');
   if(final){const message=new Uint8Array(this.fragmentBytes);let at=0;for(const part of this.fragments){message.set(part,at);at+=part.length;}frames.push({opcode:this.fragmentOpcode,payload:message});this.fragments=[];this.fragmentBytes=0;this.fragmentOpcode=0;}
  }
  this.buffer=data.slice(offset);return frames;
 }
}
export function coordinatorWsFrame(opcode:number,payload:Uint8Array):Uint8Array {
 if(![1,2,8,9,10].includes(opcode)||payload.length>262144||opcode>=8&&payload.length>125)throw Error('WS_FRAME_INVALID');
 const length=payload.length,header=length<126?new Uint8Array([128|opcode,length]):length<65536?new Uint8Array([128|opcode,126,length>>8,length&255]):new Uint8Array([128|opcode,127,0,0,0,0,(length>>>24)&255,(length>>>16)&255,(length>>>8)&255,length&255]);
 const frame=new Uint8Array(header.length+length);frame.set(header);frame.set(payload,header.length);return frame;
}
