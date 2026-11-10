import {createPhotoGallery,terminalRun} from './photo-gallery.mjs';
import {nativePhotoClient,retainPhotoOutput} from './photo-app-port.mjs';
import {SchedulerSdk} from './scheduler-sdk.js';
import {photoPort,photoWorkflow,stageLabels,comparable} from './photo-workflow.mjs';
const $=id=>document.getElementById(id),params=new URL(location.href).searchParams,group=params.get('space')||'',judge=params.get('view')==='judge'||!!window.harmonyDevice&&!window.harmonyPhoto;
const base='/v2/spaces/'+encodeURIComponent(group),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),seconds=n=>Number.isFinite(n)?(n/1000).toFixed(2):'—';
const digest=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),n=>n.toString(16).padStart(2,'0')).join('');
const appClient=window.harmonyPhoto?nativePhotoClient(window.harmonyPhoto,group,digest):null,photoFetch=appClient?.fetch||fetch;
const labels={PENDING:'等待依赖',SUBMITTED:'正在派发',OFFERED:'已分配',ACCEPTED:'已准入',RUNNING:'正在计算',SUCCEEDED:'结果已提交',FAILED:'执行失败',REJECTED:'未准入',CANCELLED_SETTLED:'已取消'};
const planningLabels={LEGAL_SUGGESTION:'可执行计划',PRIOR:'初始成本估计',MEASURED:'历史实测成本',UNKNOWN:'成本未知'};
const planLabel=value=>planningLabels[value]||value;
let sourceDeviceId='',nativeFiles=[];
let snapshot=null,current=null,record=null,history=[],busy=false,cancelled=false,selectedRun=params.get('run'),timerStart=0;
document.body.classList.toggle('judge',judge);$('dashboard').href='dispatch.html?space='+encodeURIComponent(group);$('watch').href='photo.html?space='+encodeURIComponent(group)+'&view=judge';
function error(e){$('error').hidden=!e;$('error').textContent=e?.message||'';}
async function api(route,body){const r=await photoFetch(base+route,{credentials:'same-origin',signal:AbortSignal.timeout(60000),...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});const value=await r.json();if(!r.ok)throw Error(value.error||'请求失败');return value;}
let updates=Promise.resolve();
function update(changes){const next=updates.then(async()=>{record=await api('/photo-runs/'+record.id,{revision:record.revision,...(typeof changes==='function'?changes(record):changes)});directoryAt=0;});updates=next.catch(()=>{});return next;}
const tasks=new Map();let localPreviews=[],selectionPending=false;
const gallery=createPhotoGallery({source:$('source-gallery'),output:$('preview'),base,digest,device,onError:error,fetcher:photoFetch,...(appClient?{resolveInput:appClient.input}:{}),...(window.harmonyPhoto?.stageResult?{onProduct:(product,name)=>window.harmonyPhoto.stageResult(JSON.stringify(product),name)}:{})});
function device(id){return snapshot?.devices?.find(d=>d.id===id)?.name||id?.slice(0,12)||'等待选择';}
function rows(){return current?.workflows?.flatMap(w=>w.nodes.map(n=>({...n,workflow:w.id,imageIndex:w.imageIndex})))||[];}
function render(){
 if(current)history=history.map(r=>r.id===current.id&&r.revision<=current.revision?{...r,state:current.state,sourceDurationMs:current.sourceDurationMs,revision:current.revision}:r);
 const nodes=rows(),done=nodes.filter(n=>n.committed),devices=new Set(nodes.filter(n=>n.target&&(n.committed||['ACCEPTED','RUNNING','SUCCEEDED'].includes(n.state))).map(n=>n.target.deviceId));
 $('progress').textContent=done.length+' / '+nodes.length+' 个阶段已提交';$('device-count').textContent=devices.size||'—';
 $('backend').textContent=[...new Set(nodes.filter(n=>n.target&&(n.committed||['ACCEPTED','RUNNING','SUCCEEDED'].includes(n.state))).map(n=>n.target.backend))].join(' + ')||'按已执行任务记录统计';
 const terminal=terminalRun(current);for(const id of ['run-summary','timing-panel','history-panel'])$(id).hidden=!terminal;
 if(!current)return;
 const delivered=current.images?.filter(i=>i.delivered).length??0;
 $('photo-count').innerHTML=delivered+'<small>/ '+current.inputs.length+'</small>';
 $('summary-title').textContent=current.state==='SUCCEEDED'?'本轮处理完成':current.state==='CANCELLED'?'本轮已取消':'本轮部分照片未完成';
 $('output-state').textContent=current.state==='SUCCEEDED'?'全部成品已到达':delivered?'成品持续交付中':'等待成品';
 $('device-strip').innerHTML=devices.size?[...devices].map(id=>'<span class="participant">'+esc(device(id))+'</span>').join(''):'执行设备将在任务实际分配后显示';
 $('export').disabled=false;$('run-id').textContent=current.id;$('state').textContent=current.state==='SUCCEEDED'?(current.allCommitted?'全部结果已交付':'等待执行回执核验'):current.error||({RUNNING:'正在执行真实工作流',PREPARING:'准备输入',FAILED:'本轮未完成',CANCELLED:'本轮已取消'}[current.state]||current.state);
 const duration=terminal?current.sourceDurationMs:null;
 $('elapsed').innerHTML=seconds(duration)+'<small>秒</small>';
 $('domain').textContent=current.domain==='SIMULATED'||current.mode==='LOCAL_PROCESS_TEST'?'本机进程验证 · 不代表多设备或 GPU 性能':'实际任务记录 · 硬件与网络以设备证据为准';
 // Phone business UI only needs progress/results, not the judge's graph and trace table.
 if(appClient){$('selection').textContent=current.inputs.length+' 张照片 · '+(terminal?'本轮已结束':'任务处理中');return;}
 const latest=current.workflows?.find(w=>w.state!=='SUCCEEDED')??current.workflows?.at(-1);
 if(latest){
  const bands=[['analyze'],latest.nodes.filter(n=>n.id.startsWith('prepare-')).map(n=>n.id),latest.nodes.filter(n=>n.id.startsWith('enhance-')).map(n=>n.id),['assemble'],['deliver']];
  $('graph').innerHTML=bands.map(b=>'<div class="flow-row">'+b.map(id=>{const n=latest.nodes.find(n=>n.id===id);if(!n)return '';const style=n.state==='SUCCEEDED'?'done':['RUNNING','ACCEPTED','OFFERED','SUBMITTED'].includes(n.state)?'running':['FAILED','REJECTED'].includes(n.state)?'failed':'';return `<div class="node ${style}" data-node="${esc(n.id)}"><strong>${esc(stageLabels[n.capability]||n.capability)}${id.match(/-\d+$/)?' '+(Number(id.split('-').at(-1))+1):''}</strong><small>${esc(device(n.target?.deviceId))}${n.target?' · '+esc(n.target.backend):''}</small><span class="status">${esc(labels[n.state]||n.state)}</span></div>`;}).join('')+'</div>').join('');
  requestAnimationFrame(()=>edges(latest.nodes));
  const p=latest.plan;$('plan-reason').textContent=`照片 ${latest.imageIndex+1} · ${latest.nodes.length} 个阶段 · ${p?.reason==='LEGAL_SUGGESTION'?'已生成可执行计划':p?.reason||'等待规划'}${p?.suggestionMs!=null?' · 初始计划预计 '+seconds(p.suggestionMs)+' 秒':''}。预计值不是实测完成时间。`;
 }else{
  $('graph').innerHTML='<div class="empty">等待本轮执行计划</div>';$('plan-reason').textContent='执行位置来自协调者实时规划，连线表示数据依赖。';
 }
 $('evidence').innerHTML=nodes.map(n=>`<tr><td>${esc(stageLabels[n.capability]||n.capability)}<small>照片 ${n.imageIndex+1} · ${esc(n.id)}</small></td><td>${esc(device(n.target?.deviceId))}<small>${esc(n.target?.backend||'尚未执行')}</small></td><td>${n.decision?.candidateCount??'—'} 个候选<small>${esc(planLabel(n.reason)||'等待规划')}${n.decision?.costSource?' · '+esc(planLabel(n.decision.costSource)):''}</small></td><td>${n.inputBytes??'—'} → ${n.outputBytes??'—'} B<small title="${esc(n.inputHash||'')}">${esc(n.inputHash?.slice(0,16)||'等待接收输入')}</small></td><td>${n.committed?'✓ 已提交':esc(labels[n.state]||n.state)}<small><a href="dispatch.html?space=${encodeURIComponent(group)}&job=${encodeURIComponent(n.attemptId||n.workflow)}#tasks">查看追踪 ↗</a></small></td></tr>`).join('');
 const measured=nodes.map(n=>({...n,phases:['QUEUE','ADMIT','LOAD','EXECUTE','PUBLISH'].map(phase=>({phase,ms:(n.timing||[]).filter(t=>t.phase===phase).reduce((a,t)=>a+t.durationMs,0)}))})).filter(n=>n.phases.some(p=>p.ms>0));
 const max=Math.max(1,...measured.map(n=>n.phases.reduce((a,p)=>a+p.ms,0)));
 $('timings').innerHTML=measured.length?measured.map(n=>`<div class="timing-row"><span>${esc(stageLabels[n.capability])}<small>${esc(device(n.target?.deviceId))} · ${esc(n.id)}</small></span><div class="time-track">${n.phases.map(p=>`<i class="phase-${p.phase}" style="width:${p.ms/max*100}%" title="${p.phase}：${seconds(p.ms)} 秒"></i>`).join('')}</div><strong>${seconds(n.phases.reduce((a,p)=>a+p.ms,0))} s</strong></div>`).join('')+'<p class="muted">灰：排队 · 紫：准入 · 青：载入 · 蓝：计算 · 绿：发布。各节点可重叠，不可把条形相加当作总耗时。</p>':'<p class="muted">等待执行器提交实测阶段。</p>';
 const baseline=history.find(r=>r.mode==='LOCAL'&&comparable(r,current));$('speedup').textContent=baseline?(baseline.sourceDurationMs/current.sourceDurationMs).toFixed(2)+'×':'—';
 $('history').innerHTML=history.slice(0,6).map(r=>`<article><span>${r.domain==='SIMULATED'?'本机链路验证':r.mode==='LOCAL'?'来源设备单机':'在线设备协作'}</span><strong>${r.sourceDurationMs!=null?seconds(r.sourceDurationMs)+' 秒':'未完成'}</strong><small>${r.inputs.length} 张照片 · ${esc(r.state)}<br>${esc(r.id.slice(0,8))} · ${r.budgetMs/1000} 秒预算</small></article>`).join('');
}
function edges(nodes){
 const graph=$('graph');graph.querySelector('svg')?.remove();const box=graph.getBoundingClientRect(),items=new Map([...graph.querySelectorAll('[data-node]')].map(e=>[e.dataset.node,e.getBoundingClientRect()]));
 const paths=[];for(const n of nodes){const to=items.get(n.id);if(!to)continue;for(const dep of n.dependsOn||[]){const from=items.get(dep);if(!from)continue;const x=from.x+from.width/2-box.x,y=from.bottom-box.y,tx=to.x+to.width/2-box.x,ty=to.y-box.y,mid=(y+ty)/2;paths.push(`<path d="M ${x} ${y} C ${x} ${mid}, ${tx} ${mid}, ${tx} ${ty}"/>`);}}
 graph.insertAdjacentHTML('afterbegin',`<svg class="graph-edges" width="100%" height="100%" aria-hidden="true">${paths.join('')}</svg>`);
}
let directoryAt=0,refreshing=null;
function refresh(){if(refreshing)return refreshing;refreshing=refreshOnce().finally(()=>refreshing=null);return refreshing;}
async function refreshOnce(){
 if(!group)throw Error('请先登录协作空间，再从空间内打开照片工作台。');
 if(!snapshot||Date.now()-directoryAt>5000){snapshot=await api('/photo-runs/directory');directoryAt=Date.now();$('connection').textContent=snapshot.space?.name||'协作空间已连接';}
 history=await api('/photo-runs');
 if(selectionPending)return;
 const id=selectedRun||record?.id||history[0]?.id;if(id){const next=await api('/photo-runs/'+id);
  // A slow poll must not overwrite a newer completed revision or a newly selected run.
  if(id===(selectedRun||record?.id||history[0]?.id)&&(current?.id!==id||next.revision>=current.revision))current=next;
 }
 $('freshness').textContent='已更新 · '+new Date().toLocaleTimeString();render();await gallery.render(current,record?.id===current?.id?localPreviews:[]);
}
function selection(){localPreviews.forEach(URL.revokeObjectURL);const files=nativeFiles.length?nativeFiles:[...$('files').files];localPreviews=files.map(f=>URL.createObjectURL(f));selectionPending=true;current=null;render();$('state').textContent='照片已选择 · 等待开始';$('clear').hidden=!files.length;$('selection').textContent=files.length+' 张照片已选择 · 尚未发送到执行设备';if(files.length)gallery.render({id:'selection-'+crypto.randomUUID(),state:'PREPARING',inputs:files.map(f=>({name:f.name})),images:[],workflows:[]},localPreviews);}
$('files').onchange=()=>{nativeFiles=[];selection();};
$('clear').onclick=()=>{nativeFiles=[];$('files').value='';selection();$('source-gallery').innerHTML='';$('preview').innerHTML='';};
$('fullscreen').onclick=()=>document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();
$('cancel').onclick=async()=>{cancelled=true;await Promise.allSettled([...tasks.values()].map(task=>task.cancel()));};
$('export').onclick=()=>{if(!current)return;const url=URL.createObjectURL(new Blob([JSON.stringify(current,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='photo-evidence-'+current.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('run').onclick=async()=>{
 if(busy)return;const files=nativeFiles.length?nativeFiles:[...$('files').files];if(!files.length||files.length>8){error(Error('请选择 1～8 张真实照片。'));return;}
 busy=true;cancelled=false;timerStart=performance.now();$('run').disabled=true;$('cancel').hidden=false;error(null);record=null;selectedRun=null;current=null;selectionPending=true;render();$('state').textContent='正在准备本次照片';for(const id of ['files','native-pick','usb-pick','clear','mode','budget'])$(id).disabled=true;
 try{
  const inputs=[];for(const f of files){const original=new Uint8Array(await f.arrayBuffer()),bitmap=await createImageBitmap(f);
   if(bitmap.width*bitmap.height>1048576||Math.max(bitmap.width,bitmap.height)>1920){bitmap.close();throw Error('请选择不超过 100 万像素、长边不超过 1920 像素的小图；系统不会为制造加速而缩小照片。');}
   const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0);bitmap.close();
   const normalized=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!normalized)throw Error('照片解码失败');const bytes=new Uint8Array(await normalized.arrayBuffer());
   inputs.push({name:f.name,bytes:bytes.length,originalHash:await digest(original),hash:await digest(bytes),width:canvas.width,height:canvas.height,data:bytes});
  }
  const mode=$('mode').value;if(mode==='LOCAL'&&!sourceDeviceId)throw Error('单机对照请从图片演示 App 发起，确保能识别发起设备。');const budgetMs=Number($('budget').value);record=await api('/photo-runs',{mode,sourceDeviceId,budgetMs,inputs:inputs.map(({data,...m})=>m)});
  selectionPending=false;current={...record,images:[],workflows:[]};render();await gallery.render(current,localPreviews);
  // Gallery originals are display-only. Executor inputs still go through SDK tickets.
  for(let i=0;i<inputs.length;i++){
   if(cancelled)throw Error('已取消');
   const r=await photoFetch(base+'/photo-runs/'+record.id+'/input?image='+i,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:inputs[i].data,signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error((await r.json()).error);
  }
  await update({state:'RUNNING'});let next=0;const failures=[];
  async function worker(){while(next<inputs.length&&!cancelled){const i=next++,src=inputs[i],remaining=Math.floor(budgetMs-(performance.now()-timerStart));if(remaining<1000){failures.push('总预算已耗尽');break;}
   const port=appClient?retainPhotoOutput(appClient.port(),()=>api('/photo-runs/'+record.id+'/capture-result?image='+i,{})):photoPort(group,fetch,digest,()=>{},sourceDeviceId);port.cancelled=()=>cancelled;const sdk=new SchedulerSdk(port),input=await sdk.registerInput(src.data,'image.raster'),id=crypto.randomUUID(),graph=photoWorkflow(id,input,src.width,src.height);let task;
   if(mode==='LOCAL')for(const node of graph.workflow.nodes)node.executionScope='ORIGIN_DEVICE';
   try{task=await sdk.submit(graph.workflow,{requestId:id,budgetMs:remaining,resultDestination:'ORIGIN'});tasks.set(id,task);await update(r=>({jobs:[...r.jobs,{id:task.id,imageIndex:i}]}));
    if(cancelled){await task.cancel();throw Error('已取消');}
    const result=await task.result(Math.min(300000,remaining+5000)),product=JSON.parse(new TextDecoder().decode(result.output)),decoded=Uint8Array.from(atob(product.image),c=>c.charCodeAt(0));
    if(await digest(decoded)!==product.hash)throw Error('成品哈希校验失败');
    await update({deliveredImage:{imageIndex:i,hash:product.hash}});void refresh().catch(error);
   }catch(e){failures.push(src.name+'：'+e.message);try{await (task||sdk.resume(id)).cancel();}catch{}}
   finally{tasks.delete(id);sdk.releaseInput(input);}
  }}
  // Bounded App submission, not device dispatch. Existing planner selects each node.
  await Promise.all(Array.from({length:Math.min(2,inputs.length)},()=>worker()));
  if(cancelled)throw Error('已取消');if(failures.length)throw Error(failures.join('；'));
  await update({state:'SUCCEEDED',sourceDurationMs:performance.now()-timerStart});
 }catch(e){error(e);if(record)try{await update({state:cancelled?'CANCELLED':'FAILED',error:e.message,sourceDurationMs:performance.now()-timerStart});}catch{} }
 finally{busy=false;selectionPending=false;if(refreshing)await refreshing.catch(()=>{});await refresh().catch(error);$('run').disabled=false;$('cancel').hidden=true;for(const id of ['files','native-pick','usb-pick','clear','mode','budget'])$(id).disabled=false;}
};
async function poll(){try{await refresh();}catch(e){error(e);$('freshness').textContent='连接暂不可用，保留最后一次记录';}setTimeout(poll,1000);}
async function initialize(){
 try{if(window.harmonyPhoto?.info){const info=JSON.parse(await window.harmonyPhoto.info());sourceDeviceId=info.deviceId||'';}
  if(window.harmonyPhoto?.pickPhoto){$('native-pick').hidden=false;$('files').closest('label').hidden=true;
   $('native-pick').onclick=async()=>{try{const p=JSON.parse(await window.harmonyPhoto.pickPhoto());if(!p.data)return;const bytes=Uint8Array.from(atob(p.data),c=>c.charCodeAt(0));if(nativeFiles.length>=8)throw Error('每批最多添加 8 张照片');nativeFiles.push(new File([bytes],p.name||'photo.jpg',{type:p.mime||'image/jpeg'}));selection();}catch(e){error(e);}};
  }
 }catch(e){error(e);}
 $('mode').options[1].disabled=!sourceDeviceId;void poll();
}
$('execution-details').addEventListener('toggle',()=>{if($('execution-details').open)render();});
void initialize();
