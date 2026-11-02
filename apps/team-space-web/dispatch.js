import {escapeHtml as esc,shortId,number,bytes,ms,sample,traceSummary,traceGroups} from './dispatch-view.mjs';

const $=id=>document.getElementById(id);
let group='',snapshot=null,selected='',trace=null,traceError='',stream=null,busy=false,dirty=false,timer=null,traceSerial=0;
let serverAnchor=0,clockAnchor=0;
const now=()=>serverAnchor?serverAnchor+performance.now()-clockAnchor:Date.now();
const tag=(text,kind='neutral')=>`<span class="tag ${kind}">${esc(text)}</span>`;
const empty=text=>`<div class="empty">${esc(text)}</div>`;
const name=id=>snapshot?.devices.find(d=>d.id===id)?.name??id??'UNKNOWN';
const stateKind=state=>['SUCCEEDED','COMMITTED','ACTIVE','CANARY','REACHABLE','COMPLETE'].includes(state)?'good':['FAILED','REJECTED','SIDE_EFFECT_UNKNOWN','HOLDER_RECORD_MISSING'].includes(state)?'bad':['RUNNING','ACCEPTED','DISPATCHED','DISPATCHING'].includes(state)?'':'neutral';
const date=value=>number(value)?new Date(value).toLocaleTimeString('zh-CN',{hour12:false}):'UNKNOWN';
const signal=(label,s)=>{const v=sample(s,now());return `<div class="signal"><label>${esc(label)}</label><strong title="${esc(v.reason)}">${esc(v.text)}</strong></div>`;};
const vector=items=>Array.isArray(items)?items.map(v=>`${v.resourcePoolId}: ${v.resourcePoolId==='ram'?bytes(v.amount):v.amount}`).join(' · ')||'无分配':'UNKNOWN';

async function get(route){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
  try{const response=await fetch(route,{credentials:'same-origin',cache:'no-store',signal:controller.signal});
    const body=await response.json();if(!response.ok){const e=Error(body.error??'REQUEST_FAILED');e.status=response.status;throw e;}return body;
  }finally{clearTimeout(timeout);}
}
function notice(message,warning=false){$('notice').textContent=message;$('notice').classList.toggle('warning',warning);}
function connection(text,kind='neutral'){$('connection').className='tag '+kind;$('connection').innerHTML=`<i class="led"></i>${esc(text)}`;}

function renderMetrics(){
  const values=snapshot?[
    ['已登记 / 上报设备',snapshot.devices.length,`${snapshot.devices.flatMap(d=>d.holders).length} 个宿主画像`],
    ['新鲜画像的设备',snapshot.devices.filter(d=>d.holders.some(h=>h.evidenceFresh&&sample(h.profile.ownerActivity,now()).value!==null)).length,'按上报有效期计，不推定执行空闲'],
    ['已发现执行目标',snapshot.devices.flatMap(d=>d.holders.flatMap(h=>h.profile.executors)).length,'资格与资源准入分别展示'],
    ['执行记录',snapshot.jobCount,`${snapshot.workflows.length} 个多节点工作流 · 最近 ${snapshot.jobWindow} 条可见`]
  ]:[['已登记 / 上报设备','—','等待协调者快照'],['新鲜画像的设备','—','UNKNOWN'],['已发现执行目标','—','UNKNOWN'],['执行记录','—','UNKNOWN']];
  $('metrics').innerHTML=values.map(([label,value,hint],i)=>`<article class="metric"><span class="metric-index">0${i+1}</span><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(hint)}</small></article>`).join('');
}
function renderTopology(){
  if(!snapshot){$('topology').innerHTML=empty('选择协作空间后显示实际设备');return;}
  $('topology').innerHTML=`<div class="coordinator"><span class="machine-symbol">⌘</span><strong>Harmony 协调者</strong><small>统一规划 / 控制平面</small><small class="mono">${esc(snapshot.coordinator.address??location.origin)}</small><small>快照 epoch ${esc(snapshot.coordinator.epoch)} · ${snapshot.coordinator.ready?'READY':'NOT READY'}</small></div><div class="topology-branch">${snapshot.devices.length?snapshot.devices.map(d=>{
    const fresh=d.holders.some(h=>sample(h.profile.ownerActivity,now()).value!==null);
    return `<div class="topo-node"><div><strong>${esc(d.name)}</strong><small>${esc(shortId(d.id))} / ${d.holders.length} HOLDER</small></div>${tag(fresh?'新鲜画像':d.holders.length?'画像过期 / UNKNOWN':'等待上报',fresh?'good':'neutral')}</div>`;
  }).join(''):empty('尚无设备画像。可在控制台接入设备。')}</div>`;
}
function pool(p,holderFresh){
  const total=sample(p.total,now()),limit=sample(p.admissionLimit,now()),occupied=sample(p.occupied,now());
  const ratio=number(occupied.value)&&number(limit.value)&&limit.value>0?Math.max(0,Math.min(100,occupied.value/limit.value*100)):null;
  return `<div class="pool"><div class="pool-title"><span>${esc(p.kind)} / ${esc(p.resourcePoolId)}</span><span class="pool-values">${esc(occupied.text)} / ${esc(limit.text)}</span></div><div class="meter ${ratio===null?'unknown':''}">${ratio===null?'':`<i style="width:${ratio}%"></i>`}</div><div class="pool-note">任务占用 / 准入上限 · 上报总量 ${esc(total.text)}<br>total: ${esc(total.reason)} / occupied: ${esc(occupied.reason)} · ${!holderFresh?'排空状态 UNKNOWN':p.draining?'正在排空':'上报未排空'}</div></div>`;
}
function renderDevices(){
  $('devices').innerHTML=!snapshot?empty('等待真实资源画像'):!snapshot.devices.length?empty('暂无设备；不会以样例硬件填充本页'):snapshot.devices.map(d=>`<article class="device"><div class="device-title"><h3>${esc(d.name)}</h3>${tag(d.holders.length?`${d.holders.length} HOLDER`:'UNKNOWN')}</div><div class="id">${esc(d.id)}</div>${d.holders.length?d.holders.map(h=>{
    const p=h.profile,owner=sample(p.ownerActivity,now());
    return `<section class="holder"><div class="holder-header"><span class="id">HOLDER ${esc(shortId(p.holderInstanceId))} · seq ${esc(p.sequence)} / ledger ${esc(p.ledgerEpoch)}</span>${tag(owner.value===null?'UNKNOWN':'画像有效',owner.value===null?'neutral':'good')}</div><div class="device-signals">${signal('所有者活动',p.ownerActivity)}${signal('电量',p.battery)}${signal('温度 / 热等级',p.temperature)}</div>${p.pools.length?p.pools.map(poolValue=>pool(poolValue,owner.value!==null)).join(''):empty('资源池 UNKNOWN')}<div class="targets">${p.executors.length?p.executors.map(e=>{const q=h.qualification.find(q=>q.targetId===e.target.targetId);return `<span class="target">${esc(e.target.backend)} / ${esc(e.contract.capability)}<small>${esc(q?.state??'UNKNOWN')} · ${esc(shortId(e.target.targetId))}</small></span>`;}).join(''):'<span class="muted small">执行目标 UNKNOWN（含 GPU）</span>'}</div></section>`;
  }).join(''):empty('未收到宿主画像；CPU / RAM / GPU / 温度 / 电量均 UNKNOWN')}${d.allotments.map(a=>`<div class="allotment"><span class="id">额度 HOLDER ${esc(shortId(a.holderInstanceId))} / grant v${esc(a.version)} / ack ${esc(a.ack?.version??'UNKNOWN')}</span><p>基础：${esc(vector(a.base))}</p><p>在线增量：${esc(vector(a.extra))}</p><p>保留量：${esc(vector(a.reserved))}</p><p>已确认占用：${esc(vector(a.ack?.occupied))}</p></div>`).join('')}<p class="explanation">槽位是协同资源声明，不是整机 CPU 利用率；未上报的 GPU 指标保持 UNKNOWN。</p></article>`).join('');
}
function renderNetwork(){
  const states=snapshot?.network??[];
  $('network-summary').innerHTML=states.length?`<div class="network-list">${states.map(n=>`<div class="network-row"><div>${esc(name(n.deviceId))}<small class="mono">HOLDER ${esc(shortId(n.holderInstanceId))}</small><small>${esc(n.coordinator==='REACHABLE'?'控制链路证据有效':'控制链路 UNKNOWN')} · ${n.pairs.length} 条方向证据</small></div>${tag(n.level,n.level==='L0'?'good':n.level==='L3'?'neutral':'warn')}</div>`).join('')}</div><div class="network-legend"><span>L0 全部可达</span><span>L1 部分可达</span><span>L2 仅控制可达</span><span>L3 控制未知 / 失联</span></div>`:empty('UNKNOWN · 尚无成对探测证据');
  const pairs=states.flatMap(n=>n.pairs.map(p=>({...p,holderInstanceId:n.holderInstanceId})));
  const pairRows=pairs.map(p=>{
    const link=snapshot.links.find(l=>l.holderInstanceId===p.holderInstanceId&&(l.direction==='WRITE'?l.deviceId===p.from&&l.endpointDeviceId===p.to:l.endpointDeviceId===p.from&&l.deviceId===p.to));
    const fresh=p.expiresAt>now()&&p.observedAt<=now(),reason=fresh?p.reason:'EVIDENCE_EXPIRED',estimate=reason==='REACHABLE'&&link?.expiresAt>now()?link.estimate:null;
    return `<tr><td>${esc(name(p.from))} <span class="muted">→</span> ${esc(name(p.to))}<small class="mono">HOLDER ${esc(shortId(p.holderInstanceId))}</small></td><td>${tag(reason,reason==='REACHABLE'?'good':'neutral')}</td><td class="mono">${esc(ms(estimate?.fixedMs))}</td><td class="mono">${esc(estimate&&number(estimate.bytesPerSecond)?bytes(estimate.bytesPerSecond)+'/s':'UNKNOWN')}</td><td>${reason==='REACHABLE'?'直连探测可达':'直连未知 / 不可用'}<small>中继选择以任务计划为准</small></td></tr>`;
  });
  const transfers=snapshot?.transfers??[];
  $('links').innerHTML=(pairRows.length?`<div class="table-wrap"><table><thead><tr><th>方向 / 宿主</th><th>证据状态</th><th>固定开销估计</th><th>带宽估计</th><th>路径说明</th></tr></thead><tbody>${pairRows.join('')}</tbody></table></div>`:empty('尚无链路证据；不预设直连、带宽或延迟'))+(transfers.length?`<details class="workflow-list"><summary>最近直传授权记录（${transfers.length} 条；COMPLETED 表示接收端已确认）</summary><div class="table-wrap"><table><thead><tr><th>任务</th><th>方向</th><th>端点设备</th><th>大小</th><th>状态</th></tr></thead><tbody>${transfers.map(t=>`<tr><td class="mono">${esc(shortId(t.jobId))}</td><td>${esc(t.operation)}</td><td>${esc(name(t.endpointDeviceId))}</td><td>${esc(bytes(t.bytes))}</td><td>${esc(t.state)}</td></tr>`).join('')}</tbody></table></div></details>`:'');
}
function renderJobs(){
  const jobs=snapshot?.jobs??[];
  if(!jobs.some(j=>j.id===selected))selected=jobs.find(j=>j.traceOwner)?.id??jobs[0]?.id??'';
  $('job-count').textContent=snapshot?`${jobs.length} / ${snapshot.jobCount} RECORDS`:'UNKNOWN';
  $('workflows').innerHTML=snapshot?.workflows.length?`<div class="workflow-list">${snapshot.workflows.map(w=>`<details><summary>工作流 ${esc(shortId(w.id))} · ${esc(w.state)} · ${w.nodes.length} 节点</summary>${w.nodes.map(n=>`<p class="mono">${esc(n.id)} → ${esc(shortId(n.jobId))} / ${esc(n.state)}</p>`).join('')}</details>`).join('')}</div>`:'';
  $('jobs').innerHTML=jobs.length?`<div class="table-wrap"><table><thead><tr><th>任务 / 能力</th><th>执行设备</th><th>状态</th><th>记录时间</th></tr></thead><tbody>${jobs.map(j=>`<tr class="job-row ${j.id===selected?'selected':''}" data-job="${esc(j.id)}"><td><button type="button" class="job-title" data-job="${esc(j.id)}">${esc(j.capability)}</button><small class="mono">${esc(shortId(j.id))} / ${esc(j.nodeId)}</small></td><td>${esc(name(j.deviceId))}<small class="mono">${esc(shortId(j.targetId))}</small></td><td>${tag(j.state,stateKind(j.state))}</td><td class="mono">${esc(date(j.createdAt))}</td></tr>`).join('')}</tbody></table></div>`:empty('暂无任务记录。本页不发起或改派任务。');
}
function renderDecision(){
  const job=snapshot?.jobs.find(j=>j.id===selected);
  if(!job){$('decision').innerHTML=empty('选择任务后查看调度证据');$('trace').innerHTML='';return;}
  const p=job.plan,route=job.resultDelivery==='ORIGIN_LOCAL'?'来源本地':job.transfers.length?'派发含中继读取路径':job.selectedInputEndpoint?'规划选择直连端点':'以已有副本 / 追踪证据核对';
  $('decision').innerHTML=`<div class="detail-content"><h3>${esc(job.capability)}</h3><div class="id">${esc(job.id)}</div><div class="key-value"><span>所选设备</span><strong>${esc(name(job.deviceId))}</strong></div><div class="key-value"><span>决策原因</span><strong>${esc(job.reason??'UNKNOWN')}</strong></div><div class="key-value"><span>快照 / 策略</span><strong>${esc(p?p.snapshotVersion+' / '+p.policyVersion:'UNKNOWN')}</strong></div><div class="key-value"><span>路径描述</span><strong>${esc(route)}</strong></div><div class="key-value"><span>资源结算</span><strong>${job.resourcesSettled===null?'UNKNOWN':job.resourcesSettled?'已确认结算':'尚未确认释放'}</strong></div><div class="costs"><div class="cost"><label>基线路径 · 规划估计</label><strong>${esc(ms(p?.baselineMs))}</strong></div><div class="cost chosen"><label>所选路径 · 规划估计</label><strong>${esc(ms(p?.suggestionMs))}</strong></div></div><p class="explanation">显示持久化规划结果，不重新计算或选择目标。这里只保留基线与所选方案，不补造其他候选成本；估计不是执行实测。</p>${p?.rejections.length?`<details class="rejections"><summary>${p.rejections.length} 条候选拒绝证据</summary>${p.rejections.map(r=>`<p class="mono">${esc(shortId(r.targetId))} · ${esc(r.code)}</p>`).join('')}</details>`:''}</div>`;
}
function renderTrace(){
  if(!selected){$('trace').innerHTML='';return;}
  if(traceError){$('trace').innerHTML=empty(traceError);return;}
  if(!trace){$('trace').innerHTML=empty('正在读取授权追踪…');return;}
  if(!trace.spans.length){$('trace').innerHTML=empty('尚无追踪区间，等待执行端上报。');return;}
  const summary=traceSummary(trace),max=Math.max(...trace.spans.map(s=>s.durationMs),.001);
  $('trace').innerHTML=`<div class="trace-content"><div class="trace-head"><span>阶段实测区间</span>${tag(summary.complete?'测量完整':'MEASUREMENT INCOMPLETE',summary.complete?'good':'warn')}</div><div class="key-value"><span>完整端到端 / 关键路径</span><strong>${esc(summary.endToEnd)} / ${esc(summary.critical)}</strong></div><p class="explanation">区间来自追踪接口。各时钟域分组并独立计时；条形长度仅比较区间耗时，不代表跨设备绝对先后。证据不足时不输出完整关键路径。</p>${traceGroups(trace.spans).map(group=>`<p class="eyebrow">CLOCK ${esc(shortId(group.clockDomainId))} / 同域开始时间有序</p>${group.spans.map(s=>`<div class="trace-row"><div class="trace-label"><span>${esc(s.phase)}</span><span>${esc(ms(s.durationMs))}</span></div><div class="trace-track"><i class="${summary.complete&&trace.analysis.criticalSpanIds.includes(s.spanId)?'critical':''}" style="width:${Math.max(.5,s.durationMs/max*100)}%"></i></div><div class="trace-domain">CLOCK ${esc(shortId(s.clockDomainId))} · ${esc(s.measurementScope)} · ${esc(shortId(s.targetId))}</div></div>`).join('')}`).join('')}${summary.issues.length?`<div class="issues">${summary.issues.map(esc).join('<br>')}</div>`:''}</div>`;
}
function renderFaults(){
  const jobs=(snapshot?.jobs??[]).filter(j=>j.rejection||j.yield||['FAILED','REJECTED','SIDE_EFFECT_UNKNOWN','HOLDER_RECORD_MISSING','BUDGET_EXHAUSTED'].includes(j.state));
  const feature=code=>code==='NOT_IMPLEMENTED_S6'?'尚未接入（S6）':code==='AVAILABLE'?'已接入，以事件记录为准':'UNKNOWN';
  $('faults').innerHTML=`<div class="fault-layout"><div>${jobs.length?jobs.slice(0,10).map(j=>`<div class="fault-event"><strong>${esc(j.rejection?.reasonCode??j.yield?.reasonCode??j.state)}</strong><small>${esc(shortId(j.id))} · ${esc(name(j.deviceId))} · ${esc(j.state)} · 资源结算 ${j.resourcesSettled===true?'已确认':'UNKNOWN / 未确认'}</small></div>`).join(''):empty(snapshot?'当前执行记录窗口内无已记录的拒绝、让出或失败事件':'等待协调者记录')}<p class="explanation">画像过期只表示当前证据失效，不直接判定设备故障；结果或取消状态也不代替资源结算证明。</p></div><aside class="unavailable"><h3>故障恢复能力边界</h3><p>备份执行：${feature(snapshot?.features.hedging)}</p><p>故障改派：${feature(snapshot?.features.reassignment)}</p><p>本页展示已有任务状态与让出证据，不生成恢复或改派记录。</p></aside></div>`;
}
function render(){renderMetrics();renderTopology();renderDevices();renderNetwork();renderJobs();renderDecision();renderTrace();renderFaults();}
async function loadTrace(){
  const id=selected,current=group,serial=++traceSerial;if(!id)return;
  try{const result=await get(`/v2/spaces/${encodeURIComponent(group)}/telemetry/traces/${encodeURIComponent(id)}`);if(serial!==traceSerial||id!==selected||current!==group)return;trace=result;traceError='';}
  catch(e){if(serial!==traceSerial||id!==selected||current!==group)return;trace=null;traceError=e.status===403?'仅可查看授权任务的追踪；该任务不在当前账号读取范围内。':'追踪读取失败，未将旧区间作为新结果。';}
  renderTrace();
}
async function refresh(){
  if(!group)return;if(busy){dirty=true;return;}busy=true;$('refresh').disabled=true;const current=group;
  try{const data=await get(`/v2/spaces/${encodeURIComponent(group)}/telemetry`);if(current!==group)return;
    snapshot=data;serverAnchor=data.updatedAt;clockAnchor=performance.now();$('domain').className='tag '+(data.domain==='SIMULATED'?'warn':'neutral');$('domain').textContent=data.domain==='SIMULATED'?'SIMULATED · 软件联调':data.domain+' · 数据域';
    $('updated').textContent='快照 '+date(data.updatedAt);notice(data.domain==='SIMULATED'?'当前为 SIMULATED 联调数据，不代表真实手机、GPU 或多物理设备验收。':'显示协调者当前数据；未知或过期指标显示 UNKNOWN，来源与测量范围分别标注。');
    document.querySelector('main').classList.remove('stale-data');render();await loadTrace();
  }catch(e){if(current!==group)return;document.querySelector('main').classList.add('stale-data');
    if(e.status===401||e.status===403){snapshot=null;trace=null;selected='';stream?.close();render();notice(e.status===401?'登录已失效，请返回控制台登录。':'当前账号无权读取此空间。',true);connection('访问已失效','warn');}
    else{connection('快照读取失败','warn');notice('协调者暂不可达。保留的内容是上次快照，不能视为当前状态。',true);}
  }finally{busy=false;$('refresh').disabled=false;if(dirty){dirty=false;schedule();}}
}
function schedule(){clearTimeout(timer);timer=setTimeout(()=>void refresh(),150);}
function selectSpace(id){
  stream?.close();group=id;snapshot=null;trace=null;traceError='';selected='';traceSerial++;serverAnchor=0;render();
  const url=new URL(location.href);if(id)url.searchParams.set('space',id);else url.searchParams.delete('space');history.replaceState(null,'',url);
  if(!id){connection('未选择空间');notice('请选择一个已加入的空间；接入设备与提交任务请使用控制台。');return;}
  connection('正在连接');notice('正在读取协调者快照…');void refresh();
  const source=new EventSource(`/v2/spaces/${encodeURIComponent(group)}/events`);stream=source;
  source.onopen=()=>{if(stream!==source)return;connection('实时事件已连接','good');schedule();};
  source.addEventListener('changed',()=>{if(stream===source)schedule();});
  source.onerror=()=>{if(stream!==source)return;document.querySelector('main').classList.add('stale-data');connection('事件连接中断','warn');notice('事件连接中断，内容可能过期；正在等待重连。',true);};
}
$('space').addEventListener('change',e=>selectSpace(e.target.value));$('refresh').addEventListener('click',()=>void refresh());
$('jobs').addEventListener('click',e=>{const row=e.target.closest('[data-job]');if(!row)return;selected=row.dataset.job;trace=null;traceError='';renderJobs();renderDecision();renderTrace();void loadTrace();});
setInterval(()=>{if(snapshot){renderMetrics();renderTopology();renderDevices();renderNetwork();}},5000);
setInterval(()=>{if(group&&!document.hidden)void refresh();},15000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&group)schedule();});
window.addEventListener('pagehide',()=>stream?.close());render();
if(location.protocol==='file:'){notice('请从协调者访问 /dispatch.html。本地文件打开不能读取已认证的协调者数据。',true);connection('需要协调者服务');}
else{try{const me=await get('/v2/spaces/me');$('space').innerHTML='<option value="">选择协作空间</option>'+me.spaces.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  const requested=new URL(location.href).searchParams.get('space'),initial=me.spaces.find(s=>s.id===requested)?.id??(requested?'':me.spaces[0]?.id??'');$('space').value=initial;selectSpace(initial);
  if(requested&&!initial)notice('当前账号没有这个空间的访问权限；请在控制台确认登录账号。',true);
  else if(!me.spaces.length)notice('当前账号尚未加入空间。请返回控制台创建或加入空间后查看。');
}catch(e){notice(e.status===401?'请先返回控制台登录，再打开调度盘；本页不会自动创建演示数据。':'暂时无法读取账号，请检查协调者连接。',true);connection(e.status===401?'尚未登录':'连接失败','warn');}}
