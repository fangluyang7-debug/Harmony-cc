import {SchedulerSdk,SdkTask} from './scheduler-sdk.js';
import {shoppingOrigin,capability,budgetMinor,candidatesFrom,catalogPartitionCount,partitionCandidates,mergePartitions,spacePort} from './shopping-runtime.mjs';
const $=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const group=new URL(location.href).searchParams.get('space')||'',key='harmony.shopping.v1.'+group;
const digest=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');
let snapshot=null,run=null,busy=false,stopRequested=false,cloudAbort=null;const active=new Map();
const labels={PREPARED:'等待提交',SUBMITTING:'正在规划',WAITING_INPUT:'传输输入',DISPATCHING:'派发中',DISPATCHED:'已派发',ACCEPTED:'已准入',RUNNING:'处理中',SUCCEEDED:'执行完成',FAILED:'执行失败',REJECTED:'准入拒绝',CANCELLED_SETTLED:'取消已结算',UNKNOWN:'待对账'};
function error(e){$('error').hidden=!e;$('error').textContent=e?.message||'';}
function save(){if(run){try{localStorage.setItem(key,JSON.stringify(run));}catch{error(Error('本次记录无法持久保存，请勿关闭页面，完成后导出记录。'));}}render();}
function safeUrl(value){try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)?u.href:'';}catch{return '';}}
function deviceName(id){return snapshot?.devices.find(d=>d.id===id)?.name||id||'等待规划';}
function render(){
 $('submit').disabled=busy||!snapshot;$('resume').hidden=!run||busy||run.state==='SUCCEEDED';$('cancel').hidden=!busy;$('export').hidden=!run;
 if(snapshot)$('devices').innerHTML=snapshot.devices.map(d=>{const c=d.capabilities.find(c=>c.capability===capability);return `<span class="device ${d.online&&c?.available?'ready':''}">${esc(d.name)} · ${d.online?(c?.available?'商品计算就绪':'能力检查中'):'离线'}</span>`;}).join('');
 if(!run)return;
 $('run').textContent=`${run.query} · ${run.mode==='coverage'?'覆盖在线设备验收（显式分片目标）':'协调者自动分配'} · ${run.sourceRunId||'等待购物服务 runId'}`;
 $('cloud-state').textContent=run.candidates?`${run.candidates.length} 件候选 · ${(run.cloudMs/1000).toFixed(2)} 秒`:(run.state==='SEARCHING'?'正在请求真实商品服务':run.error||'等待提交');
 const success=run.rows.filter(r=>r.state==='SUCCEEDED').length;
 $('compute-state').textContent=run.rows.length?`${success} / ${run.rows.length} 分片完成${run.computeMs!==undefined?' · '+(run.computeMs/1000).toFixed(2)+' 秒':''}`:'等待候选集';
 $('result-state').textContent=run.state==='SUCCEEDED'?`${run.result.items.length} 件 · 总耗时 ${(run.totalMs/1000).toFixed(2)} 秒`:run.state==='FAILED'?'未完成，请检查分片记录':'等待全部分片与校验';
 $('tasks').innerHTML=run.rows.length?run.rows.map(r=>`<tr><td><b>分片 ${r.index+1}</b><small>${r.inputCount} 件真实候选 · ${r.inputBytes??'—'} B</small><small>${esc(r.jobId)}</small></td><td><span class="badge ${r.state==='SUCCEEDED'?'good':r.error?'bad':''}">${esc(labels[r.state]||r.state)}</span><small>${esc(r.events.map(e=>labels[e.state]||e.state).join(' → '))}</small><small>${esc(r.error||'')}</small></td><td>${esc(deviceName(r.deviceId))}<small>${esc(r.targetId||'')}</small><small>${esc(r.reason||'')}${r.requestedDeviceId?' · 验收目标 '+esc(deviceName(r.requestedDeviceId)):''}</small></td><td>${r.output?`${r.output.items.length} 件保留 / ${r.output.excluded} 件排除`:'等待结果'}<small>${r.elapsedMs!==undefined?(r.elapsedMs/1000).toFixed(2)+' 秒（含提交和传输）':''}</small></td><td><a href="dispatch.html?space=${encodeURIComponent(group)}&job=${encodeURIComponent(r.jobId)}#tasks">调度追踪 ↗</a><small>${esc(r.traceId||'')}</small></td></tr>`).join(''):'<tr><td colspan="5">尚未提交计算分片。</td></tr>';
 if(run.state==='SUCCEEDED'){
  $('count').textContent=run.result.items.length+' 件商品';$('summary').textContent=`已校验 ${run.result.scanned} 件候选；排除 ${run.result.excluded} 件不符合币种或预算的商品。结果按价格升序，价格相同保持服务原排序。业务运行：${run.sourceRunId}`;
  $('products').innerHTML=run.result.items.map(p=>`<article class="product">${safeUrl(p.coverImageUrl)?`<img src="${esc(safeUrl(p.coverImageUrl))}" alt="${esc(p.title)}" loading="lazy">`:''}<h3>${esc(p.title)}</h3><strong>¥${(p.priceMinor/100).toFixed(2)}</strong><p>${esc(p.platformName)} · ${esc(p.shopName||'')}</p>${safeUrl(p.productUrl)?`<a href="${esc(safeUrl(p.productUrl))}" target="_blank" rel="noopener noreferrer">商品来源 ↗</a>`:''}</article>`).join('');
 }else{$('count').textContent='尚未完成';$('products').innerHTML='';$('summary').textContent='只有全部分片成功并完成完整性校验，才展示合并结果。';}
}
async function refresh(){if(!group)throw Error('请从协作空间或调度盘进入购物协同');const r=await fetch('/v2/spaces/'+encodeURIComponent(group));if(!r.ok)throw Error('请先在协作空间登录');snapshot=await r.json();$('connection').textContent=snapshot.space?.name||'已连接局域网空间';render();}
function statusUpdate(s){const row=run?.rows.find(r=>r.jobId===s.jobId);if(!row)return;if(row.events.at(-1)?.state!==s.state)row.events.push({state:s.state,at:Date.now()});Object.assign(row,{state:s.state,deviceId:s.deviceId,targetId:s.targetId,traceId:s.traceId,reason:s.reason});save();}
function port(){return spacePort(group,fetch,digest,statusUpdate);}
async function cloudSearch(query){
 async function request(route,body,token){const r=await fetch(shoppingOrigin+route,{method:'POST',signal:cloudAbort.signal,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});const result=await r.json();if(!r.ok||!result.success)throw Error(result.error?.code||'购物服务请求失败');return result.data;}
 const guest=await request('/api/v1/auth/guest',{});if(typeof guest.accessToken!=='string')throw Error('业务访客身份无效');
 return request('/api/v1/sessions/text',{message:query,entrySource:'test_app'},guest.accessToken);
}
async function collect(row,task){
 active.set(row.jobId,task);try{const result=await task.result(60000);if(result.status.state!=='SUCCEEDED')throw Error('结果状态尚未结算');const output=JSON.parse(new TextDecoder().decode(result.output));
  if(output.scanned!==row.inputCount)throw Error('分片输入数量不匹配');Object.assign(row,{output,outputHash:await digest(result.output),state:result.status.state,elapsedMs:Date.now()-row.startedAt,deviceId:result.status.deviceId,targetId:result.status.targetId,traceId:result.status.traceId});
  if(row.requestedTargetId&&row.requestedTargetId!==row.targetId)throw Error('实际执行目标与验收约束不一致');delete row.error;save();
 }catch(e){row.error=e.message;if(!['FAILED','REJECTED','CANCELLED','CANCELLED_SETTLED'].includes(row.state))row.state='UNKNOWN';save();throw e;}finally{active.delete(row.jobId);}
}
async function finish(results){
 run.computeMs=Date.now()-run.computeStartedAt;run.totalMs=Date.now()-run.startedAt;
 if(results.some(r=>r.status==='rejected')){run.state='FAILED';throw Error('部分分片未完成；保留原任务 ID，可恢复查询，不自动重投。');}
 run.result=mergePartitions(run.candidates,run.rows.map(r=>r.output),run.maxPriceMinor);run.state='SUCCEEDED';run.finishedAt=Date.now();save();
}
$('search').onsubmit=async event=>{
 event.preventDefault();if(busy)return;busy=true;stopRequested=false;error(null);
 try{
  await refresh();const query=$('query').value.trim(),maximum=budgetMinor($('budget').value),mode=$('mode').value;
  if(!query)throw Error('请输入购物需求');const declared=query.match(/(\d+(?:\.\d{1,2})?)元?(?:以内|以下)/);if(declared&&budgetMinor(declared[1])!==maximum)throw Error('购物需求与预算上限不一致');
  let targets=snapshot.devices.filter(d=>d.online).map(d=>({deviceId:d.id,name:d.name,targetId:d.capabilities.find(c=>c.capability===capability&&c.available)?.targetId})).filter(t=>t.targetId);
  if(!targets.length)throw Error('没有商品计算能力就绪的在线设备');if(mode==='coverage'&&targets.length>4)throw Error('覆盖验收最多支持四台设备');
  run={version:1,id:crypto.randomUUID(),group,query,maxPriceMinor:maximum,mode,state:'SEARCHING',startedAt:Date.now(),rows:[],sourceOrigin:shoppingOrigin};save();
  cloudAbort=new AbortController();const timeout=setTimeout(()=>cloudAbort.abort(),150000);let data;try{data=await cloudSearch(query);}finally{clearTimeout(timeout);cloudAbort=null;}
  run.cloudMs=Date.now()-run.startedAt;run.sourceRunId=data.runtimeRunId;run.candidates=candidatesFrom(data);run.sourceSessionId=data.session?.sessionId;run.state='COMPUTING';run.computeStartedAt=Date.now();save();
  if(stopRequested)throw Error('已停止，尚未提交计算分片');await refresh();
  if(mode==='coverage'&&targets.some(t=>!snapshot.devices.some(d=>d.id===t.deviceId&&d.online&&d.capabilities.some(c=>c.targetId===t.targetId&&c.available))))throw Error('检索期间设备已离线或能力不可用，请恢复设备后重新开始');
  const parts=partitionCandidates(run.candidates,catalogPartitionCount(run.candidates.length,targets.length,mode),maximum),sdkPort=port(),sdk=new SchedulerSdk(sdkPort);
  run.rows=parts.map((input,index)=>({index,jobId:crypto.randomUUID(),inputCount:input.items.length,state:'PREPARED',events:[],...(mode==='coverage'?{requestedDeviceId:targets[index].deviceId,requestedTargetId:targets[index].targetId}:{})}));save();
  const results=await Promise.allSettled(parts.map(async(value,index)=>{const row=run.rows[index],bytes=new TextEncoder().encode(JSON.stringify(value));const input=await sdk.registerInput(bytes,'catalog.items');
   try{if(stopRequested)throw Error('已停止提交');row.inputBytes=bytes.byteLength;row.inputHash=input.contentHash;row.startedAt=Date.now();row.state='SUBMITTING';row.events.push({state:'SUBMITTING',at:Date.now()});save();
    const task=await sdk.submit({version:3,id:row.jobId,outputContract:'catalog.ranked',qualityTarget:'reference',nodes:[{id:'candidate-part-'+(index+1),capability,input,parameters:JSON.stringify({sourceRunId:run.sourceRunId,partition:index,partitions:parts.length}),dependsOn:[],...(row.requestedTargetId?{targetId:row.requestedTargetId}:{})}]},{requestId:row.jobId,budgetMs:30000,resultDestination:'ORIGIN'});
    if(stopRequested)await task.cancel();await collect(row,task);
   }catch(e){row.error=e.message;if(row.state==='SUBMITTING'||row.state==='PREPARED')row.state='UNKNOWN';save();throw e;}finally{sdk.releaseInput(input);}
  }));await finish(results);
 }catch(e){if(run){run.error=e.message;if(run.state!=='SUCCEEDED')run.state='FAILED';}error(e);}finally{busy=false;cloudAbort=null;save();}
};
$('resume').onclick=async()=>{if(!run?.rows.length){error(Error('没有已提交的计算任务，请重新发起购物检索。'));return;}busy=true;error(null);render();try{await finish(await Promise.allSettled(run.rows.map(row=>row.output&&row.state==='SUCCEEDED'?Promise.resolve():collect(row,new SdkTask(row.jobId,port())))));}catch(e){error(e);}finally{busy=false;save();}};
$('cancel').onclick=async()=>{stopRequested=true;cloudAbort?.abort();const results=await Promise.allSettled([...active.values()].map(t=>t.cancel()));if(results.some(r=>r.status==='rejected'))error(Error('取消状态待对账，请恢复结果查询。'));};
$('mode').onchange=()=>{$('mode-note').textContent=$('mode').value==='coverage'?'验收模式：为每台已就绪设备约束一个真实候选分片；仍由规划器准入和派发，不代表自动最优分配或加速。':'自动模式将小候选集整批提交，由规划器选择设备，减少拆分等待；不要求每台都参与。商品价格来自服务目录，不保证实时库存或售价。';};
$('export').onclick=()=>{const u=URL.createObjectURL(new Blob([JSON.stringify(run,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=u;a.download='shopping-'+run.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);};
$('dashboard').href='dispatch.html?space='+encodeURIComponent(group)+'#tasks';
try{run=JSON.parse(localStorage.getItem(key)||'null');if(run&&(run.version!==1||run.group!==group||!Array.isArray(run.rows)||!run.rows.every(r=>Array.isArray(r.events))))run=null;}catch{run=null;}
refresh().catch(error);setInterval(()=>refresh().catch(error),3000);render();
