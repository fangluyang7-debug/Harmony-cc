import {SchedulerSdk} from './scheduler-sdk.js';
import {photoPort,photoWorkflow,stageLabels,comparable} from './photo-workflow.mjs';
const $=id=>document.getElementById(id),params=new URL(location.href).searchParams,group=params.get('space')||'',judge=params.get('view')==='judge';
const base='/v2/spaces/'+encodeURIComponent(group),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),seconds=n=>Number.isFinite(n)?(n/1000).toFixed(2):'—';
const digest=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),n=>n.toString(16).padStart(2,'0')).join('');
const labels={PENDING:'等待依赖',SUBMITTED:'正在派发',OFFERED:'已分配',ACCEPTED:'已准入',RUNNING:'正在计算',SUCCEEDED:'结果已提交',FAILED:'执行失败',REJECTED:'未准入',CANCELLED_SETTLED:'已取消'};
const planningLabels={LEGAL_SUGGESTION:'可执行计划',PRIOR:'初始成本估计',MEASURED:'历史实测成本',UNKNOWN:'成本未知'};
const planLabel=value=>planningLabels[value]||value;
let sourceDeviceId='',nativeFiles=[];
let snapshot=null,current=null,record=null,history=[],busy=false,task=null,cancelled=false,selectedRun=params.get('run'),timerStart=0;
document.body.classList.toggle('judge',judge);$('dashboard').href='dispatch.html?space='+encodeURIComponent(group);$('watch').href='photo.html?space='+encodeURIComponent(group)+'&view=judge';
function error(e){$('error').hidden=!e;$('error').textContent=e?.message||'';}
async function api(route,body){const r=await fetch(base+route,{credentials:'same-origin',signal:AbortSignal.timeout(60000),...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});const value=await r.json();if(!r.ok)throw Error(value.error||'请求失败');return value;}
async function update(changes){record=await api('/photo-runs/'+record.id,{revision:record.revision,...changes});directoryAt=0;}
function device(id){return snapshot?.devices?.find(d=>d.id===id)?.name||id?.slice(0,12)||'等待选择';}
function rows(){return current?.workflows?.flatMap(w=>w.nodes.map(n=>({...n,workflow:w.id,imageIndex:w.imageIndex})))||[];}
function render(){
 if(current)history=history.map(r=>r.id===current.id&&r.revision<=current.revision?{...r,state:current.state,sourceDurationMs:current.sourceDurationMs,revision:current.revision}:r);
 const nodes=rows(),done=nodes.filter(n=>n.committed),devices=new Set(nodes.filter(n=>n.target&&(n.committed||['ACCEPTED','RUNNING','SUCCEEDED'].includes(n.state))).map(n=>n.target.deviceId));
 $('progress').innerHTML=done.length+'<small>/ '+nodes.length+'</small>';$('device-count').textContent=devices.size||'—';
 $('backend').textContent=[...new Set(nodes.filter(n=>n.target&&(n.committed||['ACCEPTED','RUNNING','SUCCEEDED'].includes(n.state))).map(n=>n.target.backend))].join(' + ')||'按已执行任务记录统计';
 if(!current)return;
 $('export').disabled=false;$('run-id').textContent=current.id;$('state').textContent=current.state==='SUCCEEDED'?(current.allCommitted?'全部结果已交付':'等待执行回执核验'):current.error||({RUNNING:'正在执行真实工作流',PREPARING:'准备输入',FAILED:'本轮未完成',CANCELLED:'本轮已取消'}[current.state]||current.state);
 const duration=current.sourceDurationMs??(busy?performance.now()-timerStart:current.serverNow-current.createdAt);
 $('elapsed').innerHTML=seconds(duration)+'<small>秒'+(current.sourceDurationMs===null?' · 进行中':'')+'</small>';
 $('domain').textContent=current.domain==='SIMULATED'||current.mode==='LOCAL_PROCESS_TEST'?'本机进程验证 · 不代表多设备或 GPU 性能':'实际任务记录 · 硬件与网络以设备证据为准';
 const latest=current.workflows?.find(w=>w.state!=='SUCCEEDED')??current.workflows?.at(-1);
 if(latest){
  const bands=[['analyze'],latest.nodes.filter(n=>n.id.startsWith('prepare-')).map(n=>n.id),latest.nodes.filter(n=>n.id.startsWith('enhance-')).map(n=>n.id),['assemble'],['deliver']];
  $('graph').innerHTML=bands.map(b=>'<div class="flow-row">'+b.map(id=>{const n=latest.nodes.find(n=>n.id===id);if(!n)return '';const style=n.state==='SUCCEEDED'?'done':['RUNNING','ACCEPTED','OFFERED','SUBMITTED'].includes(n.state)?'running':['FAILED','REJECTED'].includes(n.state)?'failed':'';return `<div class="node ${style}" data-node="${esc(n.id)}"><strong>${esc(stageLabels[n.capability]||n.capability)}${id.match(/-\d+$/)?' '+(Number(id.split('-').at(-1))+1):''}</strong><small>${esc(device(n.target?.deviceId))}${n.target?' · '+esc(n.target.backend):''}</small><span class="status">${esc(labels[n.state]||n.state)}</span></div>`;}).join('')+'</div>').join('');
  requestAnimationFrame(()=>edges(latest.nodes));
  const p=latest.plan;$('plan-reason').textContent=`照片 ${latest.imageIndex+1} · ${latest.nodes.length} 个阶段 · ${p?.reason==='LEGAL_SUGGESTION'?'已生成可执行计划':p?.reason||'等待规划'}${p?.suggestionMs!=null?' · 初始计划预计 '+seconds(p.suggestionMs)+' 秒':''}。预计值不是实测完成时间。`;
 }
 $('evidence').innerHTML=nodes.map(n=>`<tr><td>${esc(stageLabels[n.capability]||n.capability)}<small>照片 ${n.imageIndex+1} · ${esc(n.id)}</small></td><td>${esc(device(n.target?.deviceId))}<small>${esc(n.target?.backend||'尚未执行')}</small></td><td>${n.decision?.candidateCount??'—'} 个候选<small>${esc(planLabel(n.reason)||'等待规划')}${n.decision?.costSource?' · '+esc(planLabel(n.decision.costSource)):''}</small></td><td>${n.inputBytes??'—'} → ${n.outputBytes??'—'} B<small title="${esc(n.inputHash||'')}">${esc(n.inputHash?.slice(0,16)||'等待接收输入')}</small></td><td>${n.committed?'✓ 已提交':esc(labels[n.state]||n.state)}<small><a href="dispatch.html?space=${encodeURIComponent(group)}&job=${encodeURIComponent(n.attemptId||n.workflow)}#tasks">查看追踪 ↗</a></small></td></tr>`).join('');
 const measured=nodes.map(n=>({...n,phases:['QUEUE','ADMIT','LOAD','EXECUTE','PUBLISH'].map(phase=>({phase,ms:(n.timing||[]).filter(t=>t.phase===phase).reduce((a,t)=>a+t.durationMs,0)}))})).filter(n=>n.phases.some(p=>p.ms>0));
 const max=Math.max(1,...measured.map(n=>n.phases.reduce((a,p)=>a+p.ms,0)));
 $('timings').innerHTML=measured.length?measured.map(n=>`<div class="timing-row"><span>${esc(stageLabels[n.capability])}<small>${esc(device(n.target?.deviceId))} · ${esc(n.id)}</small></span><div class="time-track">${n.phases.map(p=>`<i class="phase-${p.phase}" style="width:${p.ms/max*100}%" title="${p.phase}：${seconds(p.ms)} 秒"></i>`).join('')}</div><strong>${seconds(n.phases.reduce((a,p)=>a+p.ms,0))} s</strong></div>`).join('')+'<p class="muted">灰：排队 · 紫：准入 · 青：载入 · 蓝：计算 · 绿：发布。各节点可重叠，不可把条形相加当作总耗时。</p>':'<p class="muted">等待执行器提交实测阶段。</p>';
 const baseline=history.find(r=>r.mode==='LOCAL'&&comparable(r,current));$('speedup').textContent=baseline?(baseline.sourceDurationMs/current.sourceDurationMs).toFixed(2)+'×':'—';
 $('history').innerHTML=history.slice(0,6).map(r=>`<article><span>${r.mode==='LOCAL'?'来源设备单机':r.mode==='LOCAL_PROCESS_TEST'?'本机链路验证':'在线设备协作'}</span><strong>${r.sourceDurationMs!=null?seconds(r.sourceDurationMs)+' 秒':'未完成'}</strong><small>${r.inputs.length} 张照片 · ${esc(r.state)}<br>${esc(r.id.slice(0,8))} · ${r.budgetMs/1000} 秒预算</small></article>`).join('');
}
function edges(nodes){
 const graph=$('graph');graph.querySelector('svg')?.remove();const box=graph.getBoundingClientRect(),items=new Map([...graph.querySelectorAll('[data-node]')].map(e=>[e.dataset.node,e.getBoundingClientRect()]));
 const paths=[];for(const n of nodes){const to=items.get(n.id);if(!to)continue;for(const dep of n.dependsOn||[]){const from=items.get(dep);if(!from)continue;const x=from.x+from.width/2-box.x,y=from.bottom-box.y,tx=to.x+to.width/2-box.x,ty=to.y-box.y,mid=(y+ty)/2;paths.push(`<path d="M ${x} ${y} C ${x} ${mid}, ${tx} ${mid}, ${tx} ${ty}"/>`);}}
 graph.insertAdjacentHTML('afterbegin',`<svg class="graph-edges" width="100%" height="100%" aria-hidden="true">${paths.join('')}</svg>`);
}
let lastResult='',displayedRun='';async function showResults(){
 if(current?.id!==displayedRun){displayedRun=current?.id||'';lastResult='';$('preview').innerHTML='<div class="empty-preview">本轮实际结果完成后展示<br><small>任务输入仅在本轮开始后传输</small></div>';$('result-links').innerHTML='';}
 if(current?.state!=='SUCCEEDED'||!current.allCommitted||current.id===lastResult)return;
 try{const figures=[],links=[];for(const job of current.jobs){const r=await fetch(base+'/photo-runs/'+current.id+'/result?image='+job.imageIndex);if(!r.ok)return;const product=await r.json(),original=base+'/photo-runs/'+current.id+'/input?image='+job.imageIndex;
  figures.push(`<figure><div class="image-pair"><div><img alt="本次实际输入" src="${original}"><small>输入原图</small></div><div><img alt="本次真实 AI 增强结果" src="data:image/png;base64,${product.image}"><small>4× AI 成品</small></div></div><figcaption>照片 ${job.imageIndex+1} · ${product.width} × ${product.height} · 完整成品已校验</figcaption></figure>`);
  links.push(`<a download="harmony-enhanced-${job.imageIndex+1}.png" href="data:image/png;base64,${product.image}">保存照片 ${job.imageIndex+1} 高清成品 ↓</a>`);
 }$('preview').innerHTML=figures.join('');$('result-links').innerHTML=links.join('');lastResult=current.id;
 }catch(e){error(e);}
}
let directoryAt=0;
async function refresh(){
 if(!group)throw Error('请先登录协作空间，再从空间内打开照片工作台。');
 if(!snapshot||Date.now()-directoryAt>5000){[snapshot,history]=await Promise.all([api('/photo-runs/directory'),api('/photo-runs')]);directoryAt=Date.now();$('connection').textContent=snapshot.space?.name||'协作空间已连接';}
 const id=selectedRun||record?.id||history[0]?.id;if(id){const next=await api('/photo-runs/'+id);
  // A slow poll must not overwrite a newer completed revision or a newly selected run.
  if(id===(selectedRun||record?.id||history[0]?.id)&&(current?.id!==id||next.revision>=current.revision))current=next;
 }
 $('freshness').textContent='已更新 · '+new Date().toLocaleTimeString();render();await showResults();
}
$('files').onchange=()=>{nativeFiles=[];$('selection').textContent=$('files').files.length+' 张照片已选择 · 尚未发送到执行设备';};
$('fullscreen').onclick=()=>document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();
$('cancel').onclick=async()=>{cancelled=true;if(task)await task.cancel();};
$('export').onclick=()=>{if(!current)return;const url=URL.createObjectURL(new Blob([JSON.stringify(current,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='photo-evidence-'+current.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('run').onclick=async()=>{
 if(busy)return;const files=nativeFiles.length?nativeFiles:[...$('files').files];if(!files.length||files.length>8){error(Error('请选择 1～8 张真实照片。'));return;}
 busy=true;cancelled=false;timerStart=performance.now();$('run').disabled=true;$('cancel').hidden=false;error(null);record=null;selectedRun=null;lastResult='';
 try{
  const inputs=[];for(const f of files){const original=new Uint8Array(await f.arrayBuffer()),bitmap=await createImageBitmap(f);
   if(bitmap.width*bitmap.height>1048576||Math.max(bitmap.width,bitmap.height)>1920){bitmap.close();throw Error('请选择不超过 100 万像素、长边不超过 1920 像素的小图；系统不会为制造加速而缩小照片。');}
   const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0);bitmap.close();
   const normalized=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!normalized)throw Error('照片解码失败');const bytes=new Uint8Array(await normalized.arrayBuffer());
   inputs.push({name:f.name,bytes:bytes.length,originalHash:await digest(original),hash:await digest(bytes),width:canvas.width,height:canvas.height,data:bytes});
  }
  const mode=$('mode').value;if(mode==='LOCAL'&&!sourceDeviceId)throw Error('单机对照请从 Harmony 应用内打开，确保能识别发起设备。');const budgetMs=Number($('budget').value);record=await api('/photo-runs',{mode,sourceDeviceId,budgetMs,inputs:inputs.map(({data,...m})=>m)});
  const port=photoPort(group,fetch,digest,()=>{},sourceDeviceId);port.cancelled=()=>cancelled;const sdk=new SchedulerSdk(port);await update({state:'RUNNING'});
  for(let i=0;i<inputs.length;i++){
   if(cancelled)throw Error('已取消');const remaining=Math.floor(budgetMs-(performance.now()-timerStart));if(remaining<1000)throw Error('总预算已耗尽');
   const src=inputs[i],input=await sdk.registerInput(src.data,'image.raster'),id=crypto.randomUUID(),graph=photoWorkflow(id,input,src.width,src.height);
   if(mode==='LOCAL')for(const node of graph.workflow.nodes)node.executionScope='ORIGIN_DEVICE';
   $('plan-reason').textContent=graph.reason;
   try{task=await sdk.submit(graph.workflow,{requestId:id,budgetMs:remaining,resultDestination:'ORIGIN'});await update({jobs:[...record.jobs,{id:task.id,imageIndex:i}]});await refresh();
    const result=await task.result(Math.min(300000,remaining+5000)),product=JSON.parse(new TextDecoder().decode(result.output)),decoded=Uint8Array.from(atob(product.image),c=>c.charCodeAt(0));
    if(await digest(decoded)!==product.hash)throw Error('成品哈希校验失败');
   }catch(e){try{await (task||sdk.resume(id)).cancel();}catch{}throw e;}finally{task=null;sdk.releaseInput(input);}
  }
  await update({state:'SUCCEEDED',sourceDurationMs:performance.now()-timerStart});
 }catch(e){error(e);if(record)try{await update({state:cancelled?'CANCELLED':'FAILED',error:e.message,sourceDurationMs:performance.now()-timerStart});}catch{} }
 finally{busy=false;await refresh().catch(error);$('run').disabled=false;$('cancel').hidden=true;}
};
async function poll(){try{await refresh();}catch(e){error(e);$('freshness').textContent='连接暂不可用，保留最后一次记录';}setTimeout(poll,1000);}
async function initialize(){
 try{if(window.harmonyDevice?.info){const info=JSON.parse(await window.harmonyDevice.info());sourceDeviceId=info.deviceId||'';}
  if(window.harmonyDevice?.pickPhoto){$('native-pick').hidden=false;$('files').closest('label').hidden=true;
   $('native-pick').onclick=async()=>{try{const p=JSON.parse(await window.harmonyDevice.pickPhoto());if(!p.data)return;const bytes=Uint8Array.from(atob(p.data),c=>c.charCodeAt(0));nativeFiles=[new File([bytes],p.name||'photo.jpg',{type:p.mime||'image/jpeg'})];$('selection').textContent='1 张照片已选择 · 仍只保存在发起设备';}catch(e){error(e);}};
  }
 }catch(e){error(e);}
 $('mode').options[1].disabled=!sourceDeviceId;void poll();
}
void initialize();
