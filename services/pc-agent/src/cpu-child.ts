import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { performance } from 'node:perf_hooks';

process.on('disconnect',()=>process.exit(1));
process.once('message',async(raw:any)=>{
  try{
    const bytes=Buffer.from(raw.input,'base64');if(bytes.length>8388608||createHash('sha256').update(bytes).digest('hex')!==raw.hash)throw Error('INPUT_HASH');
    if(!Number.isSafeInteger(raw.config.threads)||raw.config.threads<1||raw.config.threads>64||!Number.isSafeInteger(raw.config.batchSize)||raw.config.batchSize<1||raw.config.batchSize>1024||raw.config.quality!=='standard')throw Error('CONFIG_UNSUPPORTED');
    const started=performance.now();let output:Buffer,schemaId:string;
    if(raw.capability==='image.crop.v1'){
      const p=raw.parameters,b=p.box,padding=p.paddingRatio;
      if(!b||![b.x,b.y,b.width,b.height,padding].every(Number.isFinite)||b.x<0||b.y<0||b.width<=0||b.height<=0||b.x+b.width>1||b.y+b.height>1||padding<0||padding>.5||!Number.isSafeInteger(p.targetSize)||p.targetSize<32||p.targetSize>1024||!Number.isSafeInteger(p.jpegQuality)||p.jpegQuality<40||p.jpegQuality>95)throw Error('CROP_INVALID');
      sharp.concurrency(raw.config.threads);const metadata=await sharp(bytes,{limitInputPixels:16777216}).metadata();const width=metadata.width!,height=metadata.height!;
      if(!width||!height)throw Error('IMAGE_INVALID');
      const cx=(b.x+b.width/2)*width,cy=(b.y+b.height/2)*height,side=Math.min(Math.max(b.width*width,b.height*height)*(1+padding*2),Math.max(width,height));
      const clamp=(v:number,min:number,max:number)=>Math.min(max,Math.max(min,v)),left=clamp(Math.round(cx-side/2),0,width-1),top=clamp(Math.round(cy-side/2),0,height-1);
      output=await sharp(bytes,{limitInputPixels:16777216}).extract({left,top,width:clamp(Math.round(cx+side/2),left+1,width)-left,height:clamp(Math.round(cy+side/2),top+1,height)-top})
        .resize({width:p.targetSize,height:p.targetSize,fit:'contain',background:{r:245,g:245,b:245,alpha:1}}).jpeg({quality:p.jpegQuality,mozjpeg:true}).toBuffer();schemaId='image.raster';
    }else if(raw.capability==='vector.normalize.v1'){
      const v=JSON.parse(bytes.toString('utf8'));
      if(!v||Object.keys(v).sort().join('|')!=='dimension|rows'||!Number.isSafeInteger(v.dimension)||v.dimension<1||v.dimension>65536||!Array.isArray(v.rows)||v.rows.length>100000)throw Error('VECTOR_INVALID');
      const rows:number[][]=[],norms:number[]=[];
      for(let i=0;i<v.rows.length;i++){
        const row=v.rows[i];if(!Array.isArray(row)||row.length!==v.dimension||!row.every(Number.isFinite))throw Error('VECTOR_INVALID');
        const norm=Math.hypot(...row);if(!Number.isFinite(norm))throw Error('VECTOR_NORM_INVALID');norms.push(norm);rows.push(row.map((n:number)=>norm===0?0:n/norm));
        if(i%raw.config.batchSize===0)await new Promise(resolve=>setImmediate(resolve));
      }
      output=Buffer.from(JSON.stringify({dimension:v.dimension,rows,norms}));schemaId='vector.normalized';
    }else if(raw.capability==='text.count.v1'){
      const v=JSON.parse(bytes.toString('utf8'));
      if(!v||Object.keys(v).join('|')!=='text'||typeof v.text!=='string')throw Error('TEXT_INVALID');
      output=Buffer.from(JSON.stringify({characters:Array.from(v.text).length,words:v.text.trim()?v.text.trim().split(/\s+/u).length:0,lines:v.text.length?v.text.split(/\r\n|\r|\n/u).length:0}));schemaId='text.counts';
    }else throw Error('CAPABILITY_UNSUPPORTED');
    if(output.length>8388608)throw Error('OUTPUT_TOO_LARGE');
    process.send?.({ok:true,output:output.toString('base64'),hash:createHash('sha256').update(output).digest('hex'),schemaId,durationMs:performance.now()-started},()=>process.disconnect());
  }catch(error){process.send?.({ok:false,error:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'CPU_FAILED'},()=>process.disconnect());}
});
