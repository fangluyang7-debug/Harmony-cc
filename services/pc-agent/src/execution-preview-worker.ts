import sharp from 'sharp';
import {createHash} from 'node:crypto';
sharp.concurrency(1);sharp.cache(false);
const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
/** Pure downsampling of actual executor buffers. No inference, files, or GPU calls. */
export async function tilePreviews(input:Buffer,output:Buffer){
 const a=JSON.parse(input.toString()),b=JSON.parse(output.toString());
 if(a.stage!=='prepared'||b.stage!=='enhanced'||b.backend!=='VULKAN'||b.scale!==4||JSON.stringify(a.rect)!==JSON.stringify(b.rect))throw Error('PREVIEW_SCOPE');
 const before=Buffer.from(a.image,'base64'),after=Buffer.from(b.image,'base64');
 if(digest(before)!==a.hash||digest(after)!==b.hash)throw Error('PREVIEW_HASH');
 const region={left:a.crop.left/4,top:a.crop.top/4,width:a.crop.width/4,height:a.crop.height/4};
 const thumb=async(p:sharp.Sharp)=>{const r=await p.resize({width:256,height:192,fit:'inside',withoutEnlargement:true}).jpeg({quality:65}).toBuffer({resolveWithObject:true});if(r.data.length>32768)throw Error('PREVIEW_SIZE');return {image:r.data.toString('base64'),width:r.info.width,height:r.info.height};};
 const original=await thumb(sharp(before,{limitInputPixels:16777216}).extract(region));
 const enhanced=await thumb(sharp(after,{limitInputPixels:16777216}));
 return {input:original,output:enhanced,region:a.rect,source:{width:a.width,height:a.height},outputHash:b.hash,outputWidth:a.rect.width*4,outputHeight:a.rect.height*4};
}
if(require.main===module){process.on('disconnect',()=>process.exit(0));process.on('message',async(m:any)=>{try{const preview=await tilePreviews(m.input,m.output);process.send?.({id:m.id,preview});}catch{process.send?.({id:m.id,error:'PREVIEW_UNAVAILABLE'});}});}
