const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={'photo.analyze.v1':'分析照片','photo.prepare.v1':'准备图块','photo.enhance.v1':'AI 高清增强','photo.assemble.v1':'合成校验','photo.deliver.v1':'生成成品'};
export const gpu=n=>['CUDA','VULKAN'].includes(n.target?.backend);
export function nodeStatus(n){
 if(n.committed)return {kind:'done',label:'回执已确认'};
 if(['FAILED','REJECTED','CANCELLED','CANCELLED_SETTLED','HOLDER_RECORD_MISSING'].includes(n.state))return {kind:'failed',label:n.state==='REJECTED'?'执行被拒绝':'未完成 / 需恢复'};
 if(n.state==='SUCCEEDED')return {kind:'publishing',label:'计算完成 · 等待确认'};
 const completed=p=>(n.timing??[]).some(t=>t.phase===p&&t.reasonCode!=='PHASE_FAILED');
 if(n.state==='RUNNING')return {kind:completed('EXECUTE')?'publishing':'running',label:completed('EXECUTE')?'发布输出':completed('LOAD')?'执行计算':'执行中 · 等待阶段证据'};
 if(n.state==='ACCEPTED')return {kind:'loading',label:'已接单 · 读取输入'};
 if(['OFFERED','DISPATCHED'].includes(n.state))return {kind:'queued',label:'已派发 · 等待接单'};
 return {kind:'pending',label:'等待依赖 / 规划'};
}
export function workflowEdges(w){const nodes=w.nodes??[];return nodes.flatMap(n=>(n.dependsOn??[]).map(id=>{const from=nodes.find(v=>v.id===id);return {from,to:n,crossDevice:!!from?.target&&!!n.target&&from.target.deviceId!==n.target.deviceId,readVerified:(n.timing??[]).some(t=>t.phase==='LOAD'&&t.reasonCode!=='PHASE_FAILED')};}));}
const bytes=v=>Number.isFinite(v)?v<1048576?(v/1024).toFixed(1)+' KiB':(v/1048576).toFixed(2)+' MiB':'未上报';
const ms=v=>Number.isFinite(v)?v.toFixed(0)+' ms':'—';
const label=n=>names[n.capability]??n.id;
let focusRun='',focusImage=null,focusNode=null;
export function renderExecutionPlan(r,container){
 if(focusRun!==r.id){focusRun=r.id;focusImage=null;focusNode=null;}
 const workflows=r.workflows??[],all=workflows.flatMap(w=>w.nodes??[]),byDevice=new Map();
 const device=id=>r.directory?.find(d=>d.id===id)?.name??(id?String(id).slice(0,8):'等待分配');
 for(const n of all)if(n.target){const id=n.target.deviceId;const row=byDevice.get(id)??{name:device(id),nodes:[]};row.nodes.push(n);byDevice.set(id,row);}
 const w=workflows.find(w=>w.imageIndex===focusImage)??workflows.find(w=>w.state!=='SUCCEEDED')??workflows.at(-1);
 if(!w){container.innerHTML='<div class="plan-empty">等待手机提交任务。规划生成后，将在这里展示真实步骤、设备与图块。</div>';return;}
 const active=w.nodes.find(n=>['RUNNING','ACCEPTED'].includes(n.state)&&!n.committed),selected=w.nodes.find(n=>n.id===focusNode)??active??w.nodes.find(n=>!n.committed)??w.nodes.at(-1);
 const bands=[['photo.analyze.v1'],['photo.prepare.v1'],['photo.enhance.v1'],['photo.assemble.v1'],['photo.deliver.v1']].map(c=>w.nodes.filter(n=>c.includes(n.capability))).filter(b=>b.length);
 const tiles=w.nodes.filter(n=>n.region&&n.capability==='photo.enhance.v1');
 const width=Math.max(1,...tiles.map(n=>n.region.x+n.region.width)),height=Math.max(1,...tiles.map(n=>n.region.y+n.region.height));
 const original=r.inputs[w.imageIndex];
 const edges=workflowEdges(w),state=nodeStatus(selected),timings=selected.timing??[];
 const related=edges.filter(e=>e.to.id===selected.id||e.from?.id===selected.id);
 container.innerHTML=`<div class="plan-toolbar"><div class="photo-tabs">${r.inputs.map((i,k)=>`<button class="photo-tab ${w.imageIndex===k?'selected':''}" data-photo="${k}">照片 ${k+1}<i class="${r.results.some(v=>v.imageIndex===k)?'done':''}"></i></button>`).join('')}</div><span class="plan-legend"><i class="live-dot"></i>正在执行 <i class="done-dot"></i>回执确认 <i class="idle-dot"></i>等待</span></div>
 <div class="device-roles">${[...byDevice.values()].map(d=>{const running=d.nodes.filter(n=>['RUNNING','ACCEPTED'].includes(n.state)&&!n.committed),done=d.nodes.filter(n=>n.committed);return `<article class="device-role ${d.nodes.some(gpu)?'gpu-role':''}"><span class="role-icon">${d.nodes.some(gpu)?'GPU':'CPU'}</span><div><strong>${esc(d.name)}</strong><p>${[...new Set(d.nodes.map(label))].map(esc).join(' · ')}</p><small>${running.length?'正在执行 '+running.length+' 个步骤':done.length===d.nodes.length?'本轮已完成':'等待派发 / 回执'} · 已确认 ${done.length} 个</small></div></article>`;}).join('')}</div>
 <div class="plan-workbench"><div class="process-path">${bands.map((b,k)=>`<section class="process-stage"><div class="stage-heading"><b>${String(k+1).padStart(2,'0')}</b><strong>${esc(label(b[0]))}</strong><span>${b.filter(n=>n.committed).length}/${b.length}</span></div><div class="stage-tasks">${b.map(n=>{const s=nodeStatus(n);return `<button class="execution-node ${s.kind} ${n.id===selected.id?'selected':''}" data-node="${esc(n.id)}"><span class="task-symbol">${gpu(n)?'GPU':n.target?'CPU':'···'}</span><span><strong>${n.region?'图块 '+(tiles.indexOf(n)+1):esc(label(n))}</strong><small>${esc(device(n.target?.deviceId))} ${n.target?'· '+esc(n.target.backend):''}</small><em>${s.label}</em></span></button>`;}).join('')}</div></section>${k<bands.length-1?'<div class="dependency-arrow">↓ <span>输出作为下一步输入</span></div>':''}`).join('')}</div>
 <aside class="execution-inspector"><p class="eyebrow">LIVE EXECUTION / 实际执行证据</p><h3>照片 ${w.imageIndex+1} · ${esc(label(selected))}</h3><span class="evidence-status ${state.kind}">${state.label}</span>
 ${tiles.length?`<div class="tile-map" style="aspect-ratio:${width}/${height}">${original?.url?`<img src="${esc(original.url)}" alt="原照片分块位置">`:''}<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="当前照片分块状态">${tiles.map((n,i)=>{const q=n.region;return `<g class="tile ${nodeStatus(n).kind} ${n.id===selected.id?'selected':''}"><rect x="${q.x}" y="${q.y}" width="${q.width}" height="${q.height}"/><text x="${q.x+q.width/2}" y="${q.y+q.height/2}" font-size="${Math.max(8,width/15)}">${i+1}</text></g>`;}).join('')}</svg></div><p class="inspector-note">图块位置来自实际规划；颜色来自任务状态。</p>`:''}
 <dl><dt>执行设备</dt><dd>${esc(device(selected.target?.deviceId))}</dd><dt>执行后端</dt><dd>${esc(selected.target?.backend??'尚未分配')}</dd>${selected.region?`<dt>原图区域</dt><dd>x ${selected.region.x}, y ${selected.region.y} · ${selected.region.width} × ${selected.region.height}</dd>`:''}<dt>做了什么</dt><dd>${selected.capability==='photo.enhance.v1'?'读取输入 → 按区域取块及边界上下文 → 神经网络推理 → 输出增强图块':selected.capability==='photo.deliver.v1'?'收集增强图块 → 合成完整照片 → 校验并编码成品':esc(label(selected))}</dd></dl>
 <div class="evidence-io"><div><small>输入 · ${selected.inputSchema==='photo.source'?'源照片':selected.inputSchema==='photo.tile'?'图块':'数据'}</small><strong>${bytes(selected.inputBytes)}</strong><code>${esc(selected.inputHash?.slice(0,16)??'等待输入')}</code></div><span>→</span><div><small>输出</small><strong>${bytes(selected.outputBytes)}</strong><code>${esc(selected.outputHash?.slice(0,16)??'等待计算')}</code></div></div>
 <div class="phase-evidence">${[['LOAD','读取输入'],['EXECUTE','执行计算'],['PUBLISH','发布输出']].map(([p,l])=>`<span>${l}<b>${timings.some(t=>t.phase===p)?ms(timings.filter(t=>t.phase===p).reduce((a,t)=>a+t.durationMs,0)):'尚无完成记录'}</b></span>`).join('')}</div>
 <div class="live-data-path"><h4>当前步骤的数据流</h4>${related.length?related.map(e=>`<div class="path-hop ${e.readVerified?'verified':''}"><span>${esc(device(e.from?.target?.deviceId))}<small>${e.from?esc(label(e.from)):'输入'}</small></span><b>→</b><span>${esc(device(e.to.target?.deviceId))}<small>${esc(label(e.to))}</small></span><em>${e.readVerified?'接收步骤已读取校验':'等待读取证据'} · ${e.crossDevice?'跨设备':'同设备 / 待分配'}</em></div>`).join(''):'<p>照片来自手机提交；当前步骤尚无后续依赖记录。</p>'}</div><details><summary>核对任务与数据路径</summary><code class="attempt-id">${esc(selected.attemptId??'尚未派发')}</code><p>GPU 标签以实际后端为依据；耗时来自已结束的阶段记录，并非 GPU 利用率。</p>${edges.filter(e=>e.to.id===selected.id||e.from?.id===selected.id).map(e=>`<p class="data-edge">${esc(device(e.from?.target?.deviceId))} → ${esc(device(e.to.target?.deviceId))}<br><small>${e.crossDevice?'跨设备数据依赖':'同设备或待分配依赖'} · ${e.readVerified?'接收步骤已完成读取校验':'等待接收步骤读取证据'}</small></p>`).join('')}<p>箭头表示数据依赖；未取得网络传输记录时，不宣称正在传输或已经送达。</p></details></aside></div>`;
 for(const b of container.querySelectorAll('[data-photo]'))b.onclick=()=>{focusImage=Number(b.dataset.photo);focusNode=null;renderExecutionPlan(r,container);};
 for(const b of container.querySelectorAll('[data-node]'))b.onclick=()=>{focusNode=b.dataset.node;renderExecutionPlan(r,container);};
}
