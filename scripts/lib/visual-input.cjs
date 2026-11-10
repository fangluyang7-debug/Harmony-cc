const zlib=require('node:zlib');
function encodeGraph(images,pairs){
 if(images.length<2||images.length>32||pairs.length<1||pairs.length>128)throw Error('VISUAL_INVALID');
 // Ship only images referenced by this partition, preserving original order.
 // This is per-run input construction, never a remote feature/result cache.
 const used=[...new Set(pairs.flat())].sort((a,b)=>a-b);
 if(used.some(i=>!Number.isInteger(i)||i<0||i>=images.length))throw Error('VISUAL_INVALID');
 pairs=pairs.map(([a,b])=>[used.indexOf(a),used.indexOf(b)]);images=used.map(i=>images[i]);
 const size=8+images.reduce((sum,im)=>sum+12+Buffer.byteLength(im.id)+im.rgb.byteLength,0)+pairs.length*8;
 const raw=Buffer.alloc(size);raw.writeUInt32LE(images.length,0);raw.writeUInt32LE(pairs.length,4);let pos=8;
 for(const im of images){const id=Buffer.from(im.id);if(!/^[A-Za-z0-9_.-]{1,100}$/.test(im.id)||im.width<32||im.height<32||im.width>512||im.height>512||im.rgb.byteLength!==im.width*im.height*3)throw Error('VISUAL_INVALID');raw.writeUInt32LE(id.length,pos);pos+=4;id.copy(raw,pos);pos+=id.length;raw.writeUInt32LE(im.width,pos);raw.writeUInt32LE(im.height,pos+4);pos+=8;Buffer.from(im.rgb).copy(raw,pos);pos+=im.rgb.byteLength;}
 const seen=new Set();for(const [a,b] of pairs){if(!Number.isInteger(a)||!Number.isInteger(b)||a<0||a>=b||b>=images.length||seen.has(a+':'+b))throw Error('VISUAL_INVALID');seen.add(a+':'+b);raw.writeUInt32LE(a,pos);raw.writeUInt32LE(b,pos+4);pos+=8;}
 const compressed=zlib.deflateSync(raw,{level:1}),out=Buffer.alloc(8+compressed.length);out.write('HVG1');out.writeUInt32LE(raw.length,4);compressed.copy(out,8);if(out.length>8388608)throw Error('VISUAL_INPUT_SIZE');return out;
}
function allPairs(count){const pairs=[];for(let a=0;a<count;a++)for(let b=a+1;b<count;b++)pairs.push([a,b]);return pairs;}
function partitionPairs(images,pairBatchSize=64){
 if(!Number.isInteger(pairBatchSize)||pairBatchSize<1||pairBatchSize>128)throw Error('VISUAL_BATCH_SIZE');
 // Upper-triangular image blocks reuse decoded images within a task and avoid
 // uploading the entire gallery with every shard. No device-specific partition.
 const side=Math.max(1,Math.floor(Math.sqrt(pairBatchSize))),batches=[];
 for(let a=0;a<images.length;a+=side)for(let b=a;b<images.length;b+=side){
  let batch=[];for(let i=a;i<Math.min(a+side,images.length);i++)for(let j=b;j<Math.min(b+side,images.length);j++)if(i<j){batch.push([i,j]);if(batch.length===pairBatchSize){batches.push(batch);batch=[];}}
  if(batch.length)batches.push(batch);
 }
 // Start larger pieces first to reduce the final partial-wave tail.
 return batches.sort((a,b)=>b.length-a.length);
}
function mergeGraph(ids,parts){
 const seen=new Set(),pairs=[];for(const p of parts){if(p.algorithm!=='dense-hog-rgb-graph-v1'||!Array.isArray(p.pairs))throw Error('VISUAL_RESULT_INVALID');for(const row of p.pairs){const a=ids.indexOf(row.a),b=ids.indexOf(row.b),key=a+':'+b;if(a<0||b<=a||seen.has(key)||!Number.isSafeInteger(row.scoreMillion)||row.scoreMillion<0||row.scoreMillion>1000000)throw Error('VISUAL_RESULT_INVALID');seen.add(key);pairs.push(row);}}
 if(pairs.length!==ids.length*(ids.length-1)/2)throw Error('VISUAL_RESULT_INCOMPLETE');return pairs.sort((a,b)=>ids.indexOf(a.a)-ids.indexOf(b.a)||ids.indexOf(a.b)-ids.indexOf(b.b));
}
module.exports={encodeGraph,allPairs,partitionPairs,mergeGraph};
