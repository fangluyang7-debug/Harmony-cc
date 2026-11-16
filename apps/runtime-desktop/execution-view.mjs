const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const token=location.hash.slice(1)||sessionStorage.getItem('runtime-token')||'';
if(location.hash){sessionStorage.setItem('runtime-token',token);history.replaceState(null,'',location.pathname);}
const terminal=r=>['SUCCEEDED','FAILED','REJECTED','CANCELLED_SETTLED'].includes(r.state),gpu=r=>['CUDA','VULKAN'].includes(r.backend);
const phase={RECEIVED:'收到任务',QUEUE:'排队等待',ADMIT:'核对资源与权限',LOAD:'读取输入',EXECUTE:'执行计算',PUBLISH:'发布结果',SUCCEEDED:'本机已完成',FAILED:'执行失败',REJECTED:'未获准执行',CANCELLED_SETTLED:'已取消并结算'};
const capability={'photo.analyze.v1':'分析照片','photo.prepare.v1':'准备图块','photo.enhance.v1':'AI 高清增强','photo.assemble.v1':'合成图像','photo.deliver.v1':'生成成品'};
const schema=s=>s==='photo.source'?'源照片（执行时按区域取块）':s==='photo.tile'?'照片图块':s==='photo.product'?'完整成品':s==='artifact.bundle'?'多个图块的组合输入':s??'未上报';
const bytes=n=>Number.isFinite(n)?n<1048576?(n/1024).toFixed(1)+' KiB':(n/1048576).toFixed(2)+' MiB':'等待记录';
const ms=n=>Number.isFinite(n)?n.toFixed(1)+' ms':'未上报';
let selected=null,current=null,stamp='',busy=false;
const thumbnails=new Map();
function previewPair(r,ready){
 const before=ready?`<img data-preview="${esc(r.id)}" data-side="input" alt="交给 GPU 的图块核心区域">`:'<span>等待图块预览</span>';
 const after=ready?`<img data-preview="${esc(r.id)}" data-side="output" alt="GPU 实际增强输出图块">`:'<span>'+esc(r.preview?.reason??(r.output?'计算已完成 · 预览待生成':'等待 GPU 实际输出'))+'</span>';
 return `<div class="preview-pair"><figure><div>${before}</div><figcaption>输入图块</figcaption></figure><span class="pixel-arrow">→</span><figure class="enhanced"><div>${after}</div><figcaption>GPU 增强输出</figcaption></figure></div>`;
}
function hydratePreviews(root,available){
 for(const [key,value] of thumbnails)if(!available.includes(key.split('/')[0])){value.then(url=>{if(url)URL.revokeObjectURL(url);});thumbnails.delete(key);}
 for(const img of root.querySelectorAll('img[data-preview]')){const id=img.dataset.preview,side=img.dataset.side,key=id+'/'+side;let request=thumbnails.get(key);
  if(!request){request=fetch('/execution/preview/'+encodeURIComponent(id)+'/'+side,{headers:{'X-Runtime-Token':token}}).then(r=>{if(!r.ok)throw Error('预览已释放');return r.blob();}).then(b=>URL.createObjectURL(b)).catch(()=>null);thumbnails.set(key,request);}
  request.then(url=>{if(!img.isConnected)return;if(url)img.src=url;else img.replaceWith(document.createTextNode('预览已释放 · 执行记录保留'));});
 }
}
function blocks(rows,data){const available=data.previewIds??[],items=rows.filter(r=>gpu(r)&&r.capability==='photo.enhance.v1').slice(0,32);
 $('block-count').textContent=available.length?'最近 '+available.length+' 块真实输出':'等待实际 GPU 图块';
 $('block-gallery').innerHTML=items.length?items.map(r=>{const ready=available.includes(r.id),p=r.preview,area=p?.region??r.region;return `<button class="block-card ${selected===r.id?'selected':''}" data-block="${esc(r.id)}"><div class="block-title"><b>${esc(r.nodeId||'增强图块')}</b><span>${ready?'实际输出':esc(phase[terminal(r)?r.state:r.phase]??r.state)}</span></div>${previewPair(r,ready)}<div class="block-location">${p?.source&&area?`<svg viewBox="0 0 ${p.source.width} ${p.source.height}" aria-label="本块在原图的位置"><rect width="100%" height="100%"/><rect class="region" x="${area.x}" y="${area.y}" width="${area.width}" height="${area.height}"/></svg>`:''}<span>${area?`原图区域 (${area.x}, ${area.y}) · ${area.width} × ${area.height}`:'区域等待上报'}<small>${p?.outputWidth?'GPU 输出 '+p.outputWidth+' × '+p.outputHeight+' · 下方仅为缩略图':'图块经过实际推理后才出现'}</small></span></div></button>`;}).join(''):'<div class="blocks-empty">手机提交照片后，分配给本机 GPU 的图块会逐块出现在这里。<br><small>不会展示样例图片、校准输入或预先生成的结果。</small></div>';
 for(const b of $('block-gallery').querySelectorAll('[data-block]'))b.onclick=()=>{selected=b.dataset.block;stamp='';render(current);$('detail').scrollIntoView({behavior:'smooth',block:'start'});};
 hydratePreviews($('block-gallery'),available);
}
export function render(data){current=data;const view=data.view,rows=view?.attempts??[],runtime=view?.runtime??{};
 $('connection').textContent=data.connected?'已连接协调中心 · 实时观察当前进程':'控制连接未在线 · 以下为本次进程已观察记录';
 $('gpu-name').textContent=runtime.gpuName??'未检测到就绪的 GPU';$('gpu-status').textContent=runtime.gpuReady?runtime.backend+' 引擎已通过就绪检查':'当前没有 GPU 就绪证据，CPU 任务仍可显示';
 $('notice').textContent=runtime.domain==='SIMULATED'?'本地模拟数据 · 仅用于页面与链路验证，不是 GPU 真机结果':!data.connected?'设备尚未连接或已停止；历史步骤不会显示为正在计算。':'真实执行记录 · 输入校验、推理、结果暂存、下游确认分别展示';
 $('active').textContent=data.connected?rows.filter(r=>!terminal(r)&&r.phase==='EXECUTE').length:0;
 $('gpu-done').textContent=rows.filter(r=>gpu(r)&&r.state==='SUCCEEDED'&&r.settled).length;
 $('sent').textContent=rows.filter(r=>r.sends?.length).length;
 $('waiting').textContent=data.connected?rows.filter(r=>!terminal(r)&&r.phase!=='EXECUTE').length:0;
 $('freshness').textContent=view?'已读取 · '+new Date().toLocaleTimeString():'';
 const next=JSON.stringify([view?.revision,data.connected,selected,data.previewIds]);if(stamp===next)return;stamp=next;
 blocks(rows,data);
 const chosen=rows.find(r=>r.id===selected)??rows.find(r=>!terminal(r))??rows[0];
 $('tiles').innerHTML=rows.length?rows.map(r=>`<button data-id="${esc(r.id)}" class="work-tile ${r.state==='SUCCEEDED'?'done':terminal(r)?'failed':data.connected&&r.phase==='EXECUTE'?'running':'waiting'} ${chosen?.id===r.id?'selected':''}"><div><b>${gpu(r)?'GPU':'CPU'}</b><small>${esc(phase[terminal(r)?r.state:r.phase]??r.state)}</small></div><strong>${esc(capability[r.capability]??r.capability)}</strong><p>${r.region?`${r.region.width} × ${r.region.height} · x ${r.region.x}, y ${r.region.y}`:'非分块步骤'}</p><code>${esc(r.id.slice(0,12))}</code></button>`).join(''):'<p class="muted">暂无真实业务任务。校准和模型预热不会计入这里。</p>';
 for(const b of $('tiles').querySelectorAll('[data-id]'))b.onclick=()=>{selected=b.dataset.id;stamp='';render(current);};
 if(!chosen){$('detail').innerHTML='<div class="empty"><span>◇</span><h2>等待真实派发</h2><p>收到任务后，显示输入、计算、输出和交付证据。</p></div>';return;}
 const r=chosen,done=r.state==='SUCCEEDED',input=!!r.input?.verified,executeDone=!!r.output,published=done,sent=!!r.sends?.length;
 const phases=[['收到任务',true],['输入校验',input],['执行计算',executeDone],['输出发布',published],['下游确认',sent]];
 $('detail').innerHTML=`<p class="eyebrow">${gpu(r)?'GPU':'CPU'} / ${esc(r.backend)} · ${esc(capability[r.capability]??r.capability)}</p><h2>${r.region?'图块执行过程':'任务执行过程'}</h2><div class="journey">${phases.map(([s,d])=>`<div class="${d?'done':''}"><i>${d?'✓':'·'}</i><span>${s}</span></div>`).join('')}</div>
 <div class="data-trip"><article><small>接收到的输入 · ${esc(schema(r.input?.schema))}</small><strong>${bytes(r.input?.bytes)}</strong><code>${esc(r.input?.hash??'尚无输入')}</code><em>${input?'哈希已校验':'等待读取与校验'}</em></article><span>↓</span><div class="engine ${!terminal(r)&&data.connected&&r.phase==='EXECUTE'?'running':''}"><b>${esc(r.backend)} ${gpu(r)?'GPU':'CPU'}</b><p>${r.capability==='photo.enhance.v1'?'按区域提取图块与边界上下文 → 超分辨率神经网络 → 增强图块':esc(capability[r.capability]??r.capability)}</p></div><span>↓</span><article><small>计算产生的输出 · ${esc(schema(r.output?.schema))}</small><strong>${bytes(r.output?.bytes)}</strong><code>${esc(r.output?.hash??'尚未产生输出')}</code><em>${sent?'下游已确认接收':r.delivery==='RELAY'?'已上传中继；最终接收待中心确认':r.delivery==='RETAINED'?'结果暂存本机；本页尚无下游确认':published?'已发布执行回执':'等待计算完成'}</em></article></div>
 <dl><dt>实际区域</dt><dd>${r.region?`x ${r.region.x}, y ${r.region.y} · ${r.region.width} × ${r.region.height}`:'非分块 / 未上报'}</dd><dt>输入来源</dt><dd>${r.routes?.length?r.routes.map(p=>esc(p.from)+' → '+esc(p.to)+(p.via?'（计划经中继）':'')).join('<br>'):'由当前步骤读取；无跨设备计划记录'}</dd><dt>执行模型</dt><dd>${esc(r.model?.modelId??(r.capability==='photo.enhance.v1'?runtime.model?.modelId:null)??'未上报 / 本步骤不使用模型')}</dd><dt>引擎推理</dt><dd>${ms(r.engineTiming?.inferenceMs)}</dd><dt>模型准备</dt><dd>${r.engineTiming?ms(r.engineTiming.modelLoadMs)+(r.engineTiming.modelLoaded?' · 本次加载':' · 引擎复用'):'未上报'}</dd><dt>整个执行阶段</dt><dd>${ms(r.timings?.EXECUTE)}</dd><dt>资源结算</dt><dd>${r.settled?'已结算':'尚未结算'}</dd></dl>
 ${gpu(r)&&r.capability==='photo.enhance.v1'?'<h3>本次 GPU 计算的图块</h3>'+previewPair(r,(data.previewIds??[]).includes(r.id))+'<p class="preview-note">这是该任务的实际输出图块，经异步缩略后展示；不是合成成品。输出发布和下游接收仍以上方回执为准。</p>':''}
 ${r.error?`<p class="failure">${esc(r.error)}</p>`:''}<details><summary>事件与完整任务 ID</summary><code class="id">${esc(r.id)}</code><p>工作流：${esc(r.workflowId)}<br>规划节点：${esc(r.nodeId)}</p>${(r.events??[]).slice(-10).reverse().map(e=>`<p class="event"><time>${new Date(e.at).toLocaleTimeString()}</time>${esc(e.event)}</p>`).join('')}${(r.sends??[]).map(s=>`<p>下游 ${esc(s.peer)} 已确认接收 ${bytes(s.bytes)} · ${esc(s.hash.slice(0,16))}</p>`).join('')}</details>`;
 hydratePreviews($('detail'),data.previewIds??[]);
}
async function refresh(){if(busy||document.visibilityState==='hidden')return;busy=true;try{const res=await fetch('/execution',{headers:{'X-Runtime-Token':token}});if(!res.ok)throw Error('会话失效，请返回调度件重新打开本页');render(await res.json());}catch(e){$('connection').textContent='暂未刷新：'+e.message;$('notice').textContent='连接中断；下方为最后一次记录，不代表任务仍在执行。';$('active').textContent='—';document.querySelectorAll('.running').forEach(e=>e.classList.remove('running'));stamp='';}finally{busy=false;}}
$('fullscreen').onclick=()=>document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();
await refresh();setInterval(refresh,500);
