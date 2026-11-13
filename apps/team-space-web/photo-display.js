import QRCode from './qrcode.js';
import {comparison,displayRounds,roundDevices} from './photo-display-compare.mjs';
const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let selected=null,pinned=false,rows=[],generation=-1,epoch=0,current=null,signature='',renderSignature='',historySignature='';
const detailCache=new Map();
const terminal=r=>['SUCCEEDED','FAILED','CANCELLED'].includes(r?.state),seconds=n=>Number.isFinite(n)?(n/1000).toFixed(2)+' 秒':'—';
async function api(route,body,headers={}){const r=await fetch(route,body?{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}:undefined);const data=await r.json();if(!r.ok)throw Error(data.error||'连接失败');return data;}
async function session(){const s=await api('/session');generation=s.generation;$('invitation').value=s.invitation;await QRCode.toCanvas($('qr'),s.invitation,{width:240,margin:2,errorCorrectionLevel:'M'});}
function gallery(r){
 const key=JSON.stringify([r?.id,r?.inputs.map(i=>i.url),r?.results.map(i=>[i.imageIndex,i.hash])]);if(signature===key)return;signature=key;
 const inputs=r?.inputs??[];$('source-gallery').dataset.count=$('preview').dataset.count=String(inputs.length);
 // An input becomes visible when its own upload completes, independently of any result.
 // Keep loaded originals mounted while other inputs/results arrive.
 if(!inputs.length)$('source-gallery').innerHTML='<div class="gallery-empty">等待手机选图</div>';
 else{
  if($('source-gallery').querySelector('.gallery-empty'))$('source-gallery').innerHTML='';
  for(let n=0;n<inputs.length;n++){
   const i=inputs[n],key=r.id+':'+n+':'+(i.url??'pending'),old=$('source-gallery').children[n];if(old?.dataset.key===key)continue;
   const card=document.createElement('figure');card.dataset.key=key;card.className='source-photo';card.innerHTML=`<div class="photo-frame">${i.url?`<img src="${esc(i.url)}" alt="${esc(i.name)}">`:'<span>正在接收原照片</span>'}</div><figcaption>${esc(i.name)}</figcaption>`;
   const img=card.querySelector('img');if(img){let retries=0;img.onerror=()=>{if(retries++<3)setTimeout(()=>{if(card.isConnected)img.src=i.url;},1000);};}
   if(old)old.replaceWith(card);else $('source-gallery').append(card);
  }
  while($('source-gallery').children.length>inputs.length)$('source-gallery').lastChild.remove();
 }
 if(!inputs.length){$('preview').innerHTML='<div class="gallery-empty">每张照片完成后，成品将在这里出现</div>';return;}
 for(let n=0;n<inputs.length;n++){const result=r.results.find(i=>i.imageIndex===n),key=r.id+':'+n+':'+(result?.hash??result?.url??'pending'),old=$('preview').children[n];if(old?.dataset.key===key)continue;const card=document.createElement('figure');card.dataset.key=key;card.className=result?'result-photo':'result-placeholder';card.innerHTML=`<div class="photo-frame ${result?'':'waiting-photo'}">${result?`<img src="${esc(result.url)}" alt="已完成成品"><span class="stamp">${result.previewOnly?'成品预览 · 原尺寸文件在手机':'已交付成品'}</span>`:'<span>等待实际处理完成</span>'}</div><figcaption>${esc(inputs[n].name)}</figcaption>`;if(old)old.replaceWith(card);else $('preview').append(card);}
 while($('preview').children.length>inputs.length)$('preview').lastChild.remove();
}
const phases=['分析照片','准备图块','AI 高清增强','合成并校验','生成高清成品'];
const stage=id=>id==='analyze'?'分析照片':id.startsWith('prepare')?'准备图块':id.startsWith('enhance')?'AI 高清增强':id==='assemble'?'合成并校验':id==='deliver'?'交付成品':id;
function render(r){const stamp=JSON.stringify([r,pinned]);if(stamp===renderSignature)return;renderSignature=stamp;current=r;gallery(r);$('mode-badge').textContent=r?.label??'等待任务';$('watch-mode').textContent=pinned?'正在回看历史轮次':'自动跟随最新任务';$('run-summary').hidden=!terminal(r);
 if(!r){$('state').textContent='连接手机或协调中心，等待下一轮任务';$('graph').innerHTML='';$('device-strip').innerHTML='';$('plan-reason').textContent='本机模式显示手机处理流程；协同模式显示协调中心的实际规划和设备分配。';$('plan-mode').textContent='等待流程';return;}
 const local=r.kind==='LOCAL';$('state').textContent=r.state==='SUCCEEDED'?'全部照片已完成并交付':r.state==='FAILED'?'本轮未完成：'+r.error:r.state==='SELECTED'?'照片已选择 · 等待手机开始':r.state==='RUNNING'?(local?`第 ${(r.imageIndex??0)+1} 张 · ${r.phase}`:'正在按实际计划执行，成品交付后逐张显示'):r.state==='PICKING'?'手机正在选择照片':'正在准备任务';
 $('connection').textContent=local?'手机本机 · 仅展示连接':'协同任务 · 实时执行回执';$('freshness').textContent='记录更新 · '+new Date(r.updatedAt).toLocaleTimeString();
 $('device-strip').innerHTML=r.devices.map(d=>'<span>'+esc(d.name)+'</span>').join('')+(local?'<span>展示端 · 仅展示，不参与本轮计算</span>':'');
 $('plan-mode').textContent=local?'本机处理事件':'协调中心实际计划';
 if(local){const phase=phases.findIndex(p=>r.phase?.startsWith(p));$('graph').innerHTML='<div class="flow-row">'+phases.map((p,n)=>`<div class="node ${r.state==='SUCCEEDED'||n<phase?'done':r.state==='RUNNING'&&n===phase?'running':''}"><strong>${p}</strong><small>手机 CPU</small><span class="status">${r.state==='SUCCEEDED'?'已完成':n===phase?'当前阶段':'本机阶段'}</span></div>`).join('')+'</div>';$('plan-reason').textContent='手机独立执行，流程来自 App 实际事件；本轮没有跨设备派发。';}
 else{const w=r.workflows.find(w=>w.state!=='SUCCEEDED')??r.workflows.at(-1);$('plan-reason').textContent=w?`照片 ${w.imageIndex+1} · ${w.nodes.length} 个阶段 · 按数据依赖从上向下执行，同一行图块可并行；设备与状态来自实际派发及回执。`:'等待协调中心生成计划';
 const bands=w?[['analyze'],w.nodes.filter(n=>n.id.startsWith('prepare')).map(n=>n.id),w.nodes.filter(n=>n.id.startsWith('enhance')).map(n=>n.id),['assemble'],['deliver']]:[];
 $('graph').innerHTML=bands.map(b=>'<div class="flow-row">'+b.map(id=>{const n=w.nodes.find(n=>n.id===id);if(!n)return '';const device=r.directory.find(d=>d.id===n.target?.deviceId)?.name??'等待分配';return `<div class="node ${n.committed?'done':['RUNNING','ACCEPTED','OFFERED'].includes(n.state)?'running':''}"><strong>${esc(stage(id))}${id.match(/-\d+$/)?' '+(Number(id.split('-').at(-1))+1):''}</strong><small>${esc(device)}${n.target?' · '+esc(n.target.backend):''}</small><span class="status">${n.committed?'已提交回执':esc(n.state)}</span></div>`;}).join('')+'</div>').join('');}
 $('elapsed').textContent=seconds(r.durationMs);$('count').textContent=r.results.length+' / '+r.inputs.length;$('device-count').textContent=r.devices.length+' 台';$('device-note').textContent=local?'手机计算 · 电脑仅展示':'根据任务执行回执统计';$('summary-title').textContent=r.state==='SUCCEEDED'?'本轮处理完成':'本轮未完成';$('export').href='/runs/'+encodeURIComponent(r.id);
}
function history(){const stamp=JSON.stringify([rows,selected]);if(stamp===historySignature)return;historySignature=stamp;const done=rows.filter(r=>r.state==='SUCCEEDED'&&Number.isFinite(r.durationMs)),max=Math.max(1,...done.map(r=>r.durationMs));$('history').innerHTML=rows.map((r,n)=>`<button class="round ${selected===r.id?'selected':''}" data-id="${esc(r.id)}"><span class="round-name"><strong>${esc(r.label)}</strong><small>${new Date(r.createdAt).toLocaleTimeString()} · ${r.inputs.length} 张照片</small><small class="round-devices">参与设备：${esc(roundDevices(r))}</small></span><span class="round-track"><i style="width:${r.state==='SUCCEEDED'?r.durationMs/max*100:0}%" class="${r.kind==='LOCAL'?'local':'coop'}"></i></span><span class="round-time">${r.state==='SUCCEEDED'?seconds(r.durationMs):r.state==='FAILED'?'未完成':'进行中'}</span></button>`).join('')||'<p class="muted">暂无记录。下一次选图与处理会自动出现在这里。</p>';
 const a=[...done].reverse().find(r=>r.kind==='LOCAL'),b=selected&&done.find(r=>r.id===selected&&r.id!==a?.id)||done.find(r=>r.id!==a?.id);const c=comparison(a,b);$('compare-note').textContent=c.reason+(c.ratio?' 相对于手机本机，本轮速度为 '+c.ratio.toFixed(2)+' 倍。':'');
 for(const button of $('history').querySelectorAll('button'))button.onclick=()=>{selected=button.dataset.id;pinned=true;epoch++;void refresh();};}
let polling=false;
async function refresh(){if(polling)return;polling=true;const version=epoch;try{const data=await api('/runs');if(version!==epoch)return;if(data.generation!==generation){await session();selected=null;pinned=false;signature='';}
 const displayed=displayRounds(data);rows=displayed.runs;if(data.managed){$('launcher').closest('label').hidden=true;$('connect-center').hidden=true;$('center-message').textContent='由新版协调中心自动连接当前空间，无需选择空间。';}$('center-status').textContent=data.coordinator.connected?'协调中心已连接 · '+data.coordinator.name:'协调中心：'+(data.coordinator.error||'尚未连接，手机本机展示仍可使用');
 if(!pinned||!rows.some(r=>r.id===selected))selected=displayed.preview?.id??rows[0]?.id??null;
 const previous=current?.id,brief=rows.find(r=>r.id===selected)??displayed.preview,cached=detailCache.get(selected);const r=selected?(cached&&terminal(brief)&&cached.revision===brief.revision&&cached.state===brief.state?cached:await api('/runs/'+encodeURIComponent(selected))):null;if(r&&terminal(r))detailCache.set(r.id,r);if(version!==epoch)return;render(r);history();if(!r)$('connection').textContent='展示服务已就绪';$('freshness').textContent=r?'记录更新 · '+new Date(r.updatedAt).toLocaleTimeString():'等待手机选图或提交协同任务';if(r&&previous!==r.id)$('pair').hidden=true;
 }catch(e){$('freshness').textContent='暂未刷新：'+e.message;}finally{polling=false;}}
$('follow').onclick=()=>{pinned=false;epoch++;void refresh();};$('pair-toggle').onclick=()=>{$('pair').hidden=!$('pair').hidden;};$('fullscreen').onclick=()=>document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText($('invitation').value);$('copy').textContent='已复制';}catch{$('invitation').select();}};
$('connect-center').onclick=async()=>{$('connect-center').disabled=true;try{$('center-message').textContent='连接中…';await api('/coordinator',{launcher:$('launcher').value},{'X-Display-Config':'1'});$('launcher').value='';$('center-message').textContent='已连接，协同轮次将自动显示';void refresh();}catch(e){$('center-message').textContent=e.message;}finally{$('connect-center').disabled=false;}};
$('reset-display').onclick=async()=>{epoch++;$('reset-display').disabled=true;try{await api('/reset',{}, {'X-Display-Reset':'1'});selected=null;pinned=false;rows=[];detailCache.clear();signature='';render(null);history();await session();$('pair').hidden=false;$('reset-message').hidden=false;$('reset-message').textContent='展示历史已清空，旧手机展示连接已失效。请使用新二维码重新连接。协作空间成员和任务执行记录不受影响。';}catch(e){$('reset-message').hidden=false;$('reset-message').textContent=e.message;}finally{$('reset-display').disabled=false;}};
await session();await refresh();setInterval(()=>void refresh(),1000);
