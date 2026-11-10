// Acquire a real shopping result once on the source computer. No device upload,
// feature extraction, or scheduling happens here. Signed image URLs/tokens are
// used only in memory and never written into the public evidence manifest.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
async function acquire(origin,directory,query='500元以内的运动鞋'){
 const base=new URL(origin);if(base.protocol!=='https:')throw Error('HTTPS_SHOPPING_ORIGIN_REQUIRED');
 fs.mkdirSync(directory,{recursive:false});
 async function post(route,body,token){const r=await fetch(new URL(route,base),{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(150000)});const j=await r.json();if(!r.ok||!j.success)throw Error('SHOPPING_HTTP_'+r.status);return j.data;}
 const start=Date.now(),guest=await post('/api/v1/auth/guest',{}),result=await post('/api/v1/sessions/text',{message:query,entrySource:'test_app'},guest.accessToken),images=[],unavailable=[];
 for(const candidate of result.candidates.items.slice(0,32)){
  try{
   const response=await fetch(candidate.coverImageUrl,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('IMAGE_HTTP_'+response.status);
   const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length<100||bytes.length>8388608)throw Error('IMAGE_SIZE');
   const sha256=createHash('sha256').update(bytes).digest('hex');if(images.some(i=>i.sha256===sha256)){unavailable.push({id:candidate.candidateItemId,reason:'DUPLICATE_ORIGINAL_BYTES'});continue;}
   const file='source-'+images.length+'.img',url=new URL(candidate.coverImageUrl);fs.writeFileSync(path.join(directory,file),bytes,{flag:'wx'});
   images.push({id:candidate.candidateItemId,title:candidate.title,price:candidate.price,file,sha256,bytes:bytes.length,sourceUrl:url.origin+url.pathname,productUrl:candidate.productUrl});
  }catch(e){unavailable.push({id:candidate.candidateItemId,reason:/^(IMAGE_HTTP_\d+|IMAGE_SIZE)$/.test(e.message)?e.message:'IMAGE_DOWNLOAD_FAILED'});}
 }
 const manifest={query,sourceRunId:result.runtimeRunId,acquiredAt:new Date().toISOString(),acquisitionMs:Date.now()-start,queryImageId:images[0]?.id,images,unavailable};
 fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2));if(images.length<2)throw Error('INSUFFICIENT_DISTINCT_IMAGES');return manifest;
}
module.exports={acquire};
if(require.main===module){const [origin,directory,query]=process.argv.slice(2);if(!origin||!directory)throw Error('SHOPPING_ORIGIN_AND_NEW_DIRECTORY_REQUIRED');acquire(origin,directory,query).then(m=>console.log(JSON.stringify({sourceRunId:m.sourceRunId,distinctImages:m.images.length,acquisitionMs:m.acquisitionMs,unavailable:m.unavailable.length}))).catch(e=>{console.error(e.message);process.exitCode=1;});}
