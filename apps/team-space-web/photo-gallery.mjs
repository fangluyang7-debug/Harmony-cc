export const terminalRun=run=>!!run&&['SUCCEEDED','FAILED','CANCELLED'].includes(run.state);
export function imageState(run,index){
 const image=run.images?.find(i=>i.imageIndex===index),workflow=run.workflows?.find(w=>w.imageIndex===index);
 if(image?.delivered)return {kind:'done',label:'已交付',workflow};
 if(workflow&&['FAILED','REJECTED','CANCELLED_SETTLED'].includes(workflow.state))return {kind:'failed',label:'未完成',workflow};
 if(terminalRun(run))return {kind:'failed',label:run.state==='CANCELLED'?'已取消':'未完成',workflow};
 if(workflow){
  const live=workflow.nodes.filter(n=>['ACCEPTED','RUNNING','OFFERED','SUBMITTED'].includes(n.state));
  return {kind:'running',label:live.some(n=>n.capability==='photo.enhance.v1')?'AI 增强中':live.some(n=>n.capability==='photo.assemble.v1')?'合成中':workflow.state==='SUCCEEDED'?'接收与校验':'处理中',workflow};
 }
 return {kind:'waiting',label:'待处理',workflow};
}
export function createPhotoGallery({source,output,base,digest,device,onError,fetcher=fetch,resolveInput=async url=>url}){
 let runId='',loaded=new Map(),pending=new Set();
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function reset(run){for(const value of loaded.values())URL.revokeObjectURL(value);loaded.clear();pending.clear();runId=run.id;source.dataset.count=String(run.inputs.length);output.dataset.count=String(run.inputs.length);
  source.innerHTML=run.inputs.map((i,index)=>`<figure class="source-photo" data-image-index="${index}"><div class="photo-frame waiting-photo"><span>等待原图</span></div><figcaption><span class="photo-name" title="${esc(i.name)}">${esc(i.name)}</span><span class="photo-state">待处理</span></figcaption></figure>`).join('');
  output.innerHTML=run.inputs.map((i,index)=>`<figure class="result-placeholder" data-image-index="${index}"><div class="photo-frame waiting-photo"><span>等待图片</span></div><figcaption>${esc(i.name)}</figcaption></figure>`).join('');
 }
 async function render(run,local=[]){if(!run)return;if(run.id!==runId)reset(run);const id=run.id;
  for(let index=0;index<run.inputs.length;index++){
   const status=imageState(run,index),sourceCard=source.children[index],remote=run.images?.find(i=>i.imageIndex===index),src=local[index]||(remote?.inputAvailable?`${base}/photo-runs/${encodeURIComponent(id)}/input?image=${index}`:'');
   sourceCard.className='source-photo is-'+status.kind;sourceCard.querySelector('.photo-state').textContent=status.label;
   if(src&&!sourceCard.querySelector('img')){const resolved=local[index]?src:await resolveInput(src);if(id!==runId)return;const img=new Image();img.alt=run.inputs[index].name+' · 原图';img.src=resolved;sourceCard.querySelector('.photo-frame').replaceChildren(img);}
   if(!remote?.delivered){if(status.kind==='failed')output.children[index].querySelector('.waiting-photo span').textContent=status.label;continue;}
   if(loaded.has(index)||pending.has(index))continue;pending.add(index);
   // Only a server-verified per-image delivery may cause a finished photo to appear.
   void (async()=>{let url='';try{
    const response=await fetcher(`${base}/photo-runs/${encodeURIComponent(id)}/result?image=${index}`,{signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('成品暂未取到，将自动重试');
    const product=await response.json(),bytes=Uint8Array.from(atob(product.image),c=>c.charCodeAt(0));if(await digest(bytes)!==product.hash)throw Error('成品哈希校验失败');
    url=URL.createObjectURL(new Blob([bytes],{type:'image/png'}));const img=new Image();img.src=url;img.alt=run.inputs[index].name+' · 真实 AI 成品';await img.decode();
    if(id!==runId){URL.revokeObjectURL(url);return;}loaded.set(index,url);
    const card=document.createElement('figure');card.className='result-photo';card.dataset.imageIndex=String(index);card.dataset.receivedAt=String(remote.receivedAt??'');
    const names=[...new Set(status.workflow?.nodes.filter(n=>n.committed&&n.target).map(n=>device(n.target.deviceId))??[])];
    card.innerHTML=`<div class="photo-frame"><span class="stamp">已校验交付</span></div><figcaption><span class="photo-name" title="${esc(run.inputs[index].name)}">${esc(run.inputs[index].name)}</span><a download="harmony-enhanced-${index+1}.png" href="${url}">保存 ↙</a></figcaption><span class="assigned" title="${esc(names.join(' · '))}">${esc(names.join(' · '))}</span>`;
    card.querySelector('.photo-frame').prepend(img);output.children[index].replaceWith(card);
   }catch(e){if(url&&!loaded.has(index))URL.revokeObjectURL(url);if(id===runId)onError(e);}finally{if(id===runId)pending.delete(index);}})();
  }
 }
 return {render,reset};
}
