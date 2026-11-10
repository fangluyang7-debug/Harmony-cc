import {escapeHtml as esc,shortId,number,bytes,ms,sample,traceSummary} from './dispatch-view.mjs';
import {replaceContent,navigate} from './dispatch-layout.js';
import {capacity,clockLanes,costScale,networkLevels} from './dispatch-charts.mjs';

const $=id=>document.getElementById(id);
let group='',snapshot=null,selected='',trace=null,traceError='',stream=null,busy=false,dirty=false,timer=null,traceSerial=0;
let serverAnchor=0,clockAnchor=0;
const now=()=>serverAnchor?serverAnchor+performance.now()-clockAnchor:Date.now();
const labels={SUCCEEDED:'执行成功',COMMITTED:'结果已提交',ACTIVE:'已激活',RUNNING:'执行中',ACCEPTED:'已接收',DISPATCHED:'已派发',DISPATCHING:'派发中',FAILED:'执行失败',REJECTED:'已拒绝',WAITING_INPUT:'等待输入',SUBMITTED:'已提交',CANCELLED_SETTLED:'取消已结算',REACHABLE:'可达',SIDE_EFFECT_UNKNOWN:'副作用未知',HOLDER_RECORD_MISSING:'宿主记录缺失'};
const tag=(text,kind='neutral')=>`<span class="tag ${kind}" title="${esc(text)}">${esc(Object.hasOwn(labels,text)?labels[text]:text)}</span>`;
const capabilities={'image.visual-match.v1':'商品图像相似度复核','catalog.filter.v1':'商品预算筛选与排序','text.count.v1':'文本统计','vector.normalize.v1':'向量归一化','image.crop.v1':'图像裁剪','render.fractal.v1':'CPU 分块渲染','photo.analyze.v1':'照片分析与校正','photo.prepare.v1':'照片图块准备','photo.enhance.v1':'AI 照片高清增强','photo.assemble.v1':'照片合成与校验','photo.deliver.v1':'照片成品与预览'};
const capabilityLabel=value=>Object.hasOwn(capabilities,value)?capabilities[value]:value;
const phases={PLAN:'规划',OFFER:'派发',QUEUE:'排队',ADMIT:'准入',LOAD:'加载',EXECUTE:'执行',PUBLISH:'发布'};
const icon=kind=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${kind==='coordinator'?'<rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 9h6v6H9zM8 2v3m8-3v3M8 19v3m8-3v3M2 8h3m-3 8h3M19 8h3m-3 8h3"/>':'<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5M7 8h4m-4 3h9"/>'}</svg>`;
const empty=text=>`<div class="empty">${esc(text)}</div>`;
const name=id=>snapshot?.devices.find(d=>d.id===id)?.name??id??'UNKNOWN';
const stateKind=state=>['SUCCEEDED','COMMITTED','ACTIVE','CANARY','REACHABLE','COMPLETE'].includes(state)?'good':['FAILED','REJECTED','SIDE_EFFECT_UNKNOWN','HOLDER_RECORD_MISSING'].includes(state)?'bad':['RUNNING','ACCEPTED','DISPATCHED','DISPATCHING'].includes(state)?'':'neutral';
const date=value=>number(value)?new Date(value).toLocaleTimeString('zh-CN',{hour12:false}):'UNKNOWN';
const signal=(label,s)=>{const v=sample(s,now());return `<div class="signal"><label>${esc(label)}</label><strong data-unknown="${v.value===null}" title="${esc(v.reason)}">${esc(v.text)}</strong></div>`;};
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
    ['设备规模',snapshot.devices.length,`已登记 / 上报 · ${snapshot.devices.flatMap(d=>d.holders).length} 个宿主`],
    ['有效画像设备',snapshot.devices.filter(d=>d.holders.some(h=>h.evidenceFresh&&sample(h.profile.ownerActivity,now()).value!==null)).length,'按画像有效期统计，非空闲数'],
    ['执行目标',snapshot.devices.flatMap(d=>d.holders.flatMap(h=>h.profile.executors)).length,'已发现能力 · 准入资格另行核验'],
    ['执行记录',snapshot.jobCount,`${snapshot.workflows.length} 个工作流 · 最近 ${snapshot.jobWindow} 条可见`]
  ]:[['设备规模','—','等待协调者快照'],['有效画像设备','—','UNKNOWN'],['执行目标','—','UNKNOWN'],['执行记录','—','UNKNOWN']];
  $('metrics').innerHTML=values.map(([label,value,hint],i)=>`<article class="metric"><span class="metric-index">0${i+1}</span><span>${esc(label)}</span><strong>${esc(value)}<em>${['台','台','个','条'][i]}</em></strong><small>${esc(hint)}</small></article>`).join('');
}
function renderTopology(){
  if(!snapshot){$('topology').innerHTML=empty('选择协作空间后显示实际设备');return;}
  const devices=snapshot.devices,n=devices.length;
  const wires=n?`<svg class="topology-wires" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path class="wire-spine" d="M0 50 H45 ${n>1?'M45 '+50/n+' V'+(100-50/n):''}"/>${devices.map((d,i)=>{const y=(i+.5)/n*100;return `<path class="wire-branch" d="M45 ${y} H100"/><circle cx="100" cy="${y}" r="2" vector-effect="non-scaling-stroke"/>`;}).join('')}</svg>`:'';
  replaceContent('topology',`<div class="map-caption"><span>统一规划中心</span><span>${n} 台登记 / 上报终端</span></div><div class="topology-scroll"><div class="topology-scene" style="--node-count:${Math.max(1,n)}"><div class="topology-hub"><div class="hub-orbit"><div class="hub-core">${icon('coordinator')}</div><span class="orbit-point" aria-hidden="true"></span></div><strong>Harmony 协调者</strong><span class="hub-role">规划 · 资源协调</span><small class="coordinator-address">${esc(snapshot.coordinator.address??location.origin)}</small><span class="hub-state">快照 ${snapshot.coordinator.ready?'READY':'NOT READY'} · epoch ${esc(snapshot.coordinator.epoch)}</span></div>${wires}<div class="topology-nodes">${n?devices.map(d=>{
    const readings=d.holders.map(h=>sample(h.profile.ownerActivity,now())),fresh=readings.some(v=>v.value!==null),profileLabel=fresh?'画像有效':!d.holders.length?'等待上报':readings.some(v=>v.reason==='证据已过期或时间无效')?'画像过期':'画像未知',executors=d.holders.flatMap(h=>h.profile.executors),backends=[...new Set(executors.map(e=>e.target.backend))];
    return `<button class="topo-device ${fresh?'fresh':'unknown'}" data-device="${esc(d.id)}" type="button" aria-label="查看 ${esc(d.name)} 的设备资源"><span class="node-icon">${icon('device')}</span><span class="node-content"><strong>${esc(d.name)}</strong><span class="node-meta">${d.holders.length} 个宿主 · ${executors.length} 个执行目标${backends.length?' · '+esc(backends.join(' / ')):''}</span><span class="node-id">${esc(shortId(d.id))}</span></span><span class="node-state"><i class="led"></i>${esc(profileLabel)}${fresh?'':' / UNKNOWN'}</span><span class="node-arrow" aria-hidden="true">↗</span></button>`;
  }).join(''):empty('暂无设备画像。接入终端后显示协作关系。')}</div></div></div><div class="map-legend"><span><i class="line-key"></i>画像关联</span><span><i class="led"></i>有效画像</span><span>点击终端查看资源 ↗</span></div>`);
}
function pool(p,holderFresh){
  const total=sample(p.total,now()),limit=sample(p.admissionLimit,now()),occupied=sample(p.occupied,now()),usage=capacity(occupied.value,limit.value);
  const label={CPU_SLOTS:'CPU 协同槽位',RAM_BYTES:'内存额度'}[p.kind]??p.kind,tone=p.kind==='RAM_BYTES'?'memory':'compute';
  const percent=usage===null?'—':usage.percent.toFixed(usage.percent>0&&usage.percent<1?1:0)+'%';
  return `<div class="pool ${tone} ${usage?.exceeded?'over-capacity':''}"><div class="capacity-ring ${usage===null?'unknown':''}" role="img" aria-label="${esc(label+'，任务占用 '+occupied.text+'，准入上限 '+limit.text)}"><svg viewBox="0 0 100 100" aria-hidden="true"><circle class="ring-track" cx="50" cy="50" r="42"/>${usage===null?'':`<circle class="ring-value" cx="50" cy="50" r="42" pathLength="100" stroke-dasharray="${usage.fill} 100"/>`}</svg><span><strong>${percent}</strong><small>${usage===null?'UNKNOWN':'额度占用'}</small></span></div><div class="pool-info"><div class="pool-title"><strong>${esc(label)}</strong><span>${!holderFresh?'排空 UNKNOWN':p.draining?'正在排空':'未排空'}</span></div><div class="pool-values"><strong>${esc(occupied.text)}</strong><span> / ${esc(limit.text)}</span></div><div class="pool-note">任务占用 / 准入上限${usage?.exceeded?' · 已超出上限':''}<br>上报总量 ${esc(total.text)}</div></div></div>`;
}
function renderDevices(){
  replaceContent('devices',!snapshot?empty('等待真实资源画像'):!snapshot.devices.length?empty('暂无设备；不会以样例硬件填充本页'):snapshot.devices.map(d=>`<article class="device" data-device-card="${esc(d.id)}" tabindex="-1"><div class="device-title"><h3>${esc(d.name)}</h3>${tag(d.holders.length?`${d.holders.length} 个宿主`:'UNKNOWN')}</div><div class="id">${esc(d.id)}</div>${d.holders.length?d.holders.map(h=>{
    const p=h.profile,owner=sample(p.ownerActivity,now());
    const live=p.inFlight===undefined||!h.evidenceFresh||p.ownerActivity.sampledAt+p.ownerActivity.ttlMs<now()?'UNKNOWN':p.inFlight.length?p.inFlight.map(f=>`<p>${esc(shortId(f.attemptId))} · ${esc(f.state)} · 占用 ${esc(vector(f.resources))} · 已运行 ${esc(sample(f.elapsed,now()).text)} · 预计剩余 ${esc(sample(f.remaining,now()).text)}${f.history&&sample(f.elapsed,now()).value!==null?` · 参考 ${esc(f.history.samples)} 次，其中 ${esc(f.history.survivors)} 次超过当前用时 · 剩余 P90 ${esc(ms(f.history.p90RemainingMs))}`:''}</p>`).join(''):'采样时无未结算任务';
    const queued=owner.value===null?'':(p.queued??[]).map(q=>`<p>排队 ${esc(shortId(q.attemptId))} · ${esc(q.reason)} · 等待 ${esc(sample(q.elapsed,now()).text)} · 申请 ${esc(vector(q.resources))}</p>`).join('');
    const controlLabels={ONLINE:'控制连接在线',SUSPECT:'控制连接疑似失联',RECONCILING:'等待对账与画像',OFFLINE:'控制连接离线'};
    const control=tag(controlLabels[h.controlState]??'控制连接未知',h.controlState==='ONLINE'?'good':'warn');
    const blockers={NON_INTERRUPTIBLE_RUNNING:'不可中断任务占用',RELEASE_OVERDUE:'不可中断任务超过声明时长'};
    const forecasts=(h.resourceForecasts??[]).filter(a=>a.reason==='RESOURCE_CAPACITY').map(a=>`<p>目标 ${esc(shortId(a.targetId))} · ${blockers[a.blockingReason]??'资源占用'} · 等待估计 ${esc(sample(a.resourceWait,now()).text)}</p>`).join('');
    return `<section class="holder"><div class="holder-header"><span class="id">HOLDER ${esc(shortId(p.holderInstanceId))} · seq ${esc(p.sequence)} / ledger ${esc(p.ledgerEpoch)}</span>${control}${tag(owner.value===null?'UNKNOWN':'画像有效',owner.value===null?'neutral':'good')}</div><div class="device-signals">${signal('所有者活动',p.ownerActivity)}${signal('电量',p.battery)}${signal('温度 / 热等级',p.temperature)}</div><div class="resource-pools">${p.pools.length?p.pools.map(poolValue=>pool(poolValue,owner.value!==null)).join(''):empty('资源池 UNKNOWN')}</div><details class="evidence-details" data-detail="${esc('work-'+p.holderInstanceId)}"><summary>在途任务与资源等待</summary>${live}${queued}${forecasts}</details><div class="targets">${p.executors.length?p.executors.map(e=>{const q=h.qualification.find(q=>q.targetId===e.target.targetId);return `<span class="target">${esc(e.target.backend)} / ${esc(capabilityLabel(e.contract.capability))}<small>${esc(e.contract.capability)} · ${esc(q?.state??'UNKNOWN')} · ${esc(shortId(e.target.targetId))}</small></span>`;}).join(''):'<span class="muted small">执行目标 UNKNOWN（含 GPU）</span>'}</div><details class="evidence-details" data-detail="${esc('sources-'+p.holderInstanceId)}"><summary>资源采集来源与有效性</summary>${p.pools.map(v=>`<p>${esc(v.kind+' / '+v.resourcePoolId)} · 总量 ${esc(sample(v.total,now()).reason)} · 占用 ${esc(sample(v.occupied,now()).reason)} · 准入 ${esc(sample(v.admissionLimit,now()).reason)}</p>`).join('')}</details></section>`;
  }).join(''):empty('未收到宿主画像；CPU / RAM / GPU / 温度 / 电量均 UNKNOWN')}<details class="evidence-details" data-detail="${esc(d.id)}"><summary>额度与资源结算 · ${d.allotments.length} 个宿主记录</summary>${d.allotments.map(a=>`<div class="allotment"><span class="id">额度 HOLDER ${esc(shortId(a.holderInstanceId))} / grant v${esc(a.version)} / ack ${esc(a.ack?.version??'UNKNOWN')}</span><p>基础：${esc(vector(a.base))}</p><p>在线增量：${esc(vector(a.extra))}</p><p>保留量：${esc(vector(a.reserved))}</p><p>已确认占用：${esc(vector(a.ack?.occupied))}</p></div>`).join('')}</details><p class="explanation">槽位是协同资源声明，不是整机 CPU 利用率；未上报的 GPU 指标保持 UNKNOWN。</p></article>`).join(''));
}
function renderNetwork(){
  const states=snapshot?.network??[],counts=networkLevels(states);
  const distribution=states.length?`<div class="network-distribution"><div class="distribution-title"><span>宿主网络等级</span><strong>${states.length}<small> 个宿主</small></strong></div><div class="network-stack" role="img" aria-label="${esc(Object.entries(counts).map(([k,v])=>k+' '+v+' 个').join('，'))}">${Object.entries(counts).filter(([,v])=>v).map(([level,count])=>`<span class="level-${level}" style="width:${count/states.length*100}%">${level} · ${count}</span>`).join('')}</div><div class="level-counts">${Object.entries(counts).filter(([k,v])=>k!=='UNKNOWN'||v).map(([k,v])=>`<span><i class="level-${k}"></i>${k}<b>${v}</b></span>`).join('')}</div></div>`:'';
  replaceContent('network-summary',states.length?`${distribution}<div class="network-list">${states.map(n=>`<div class="network-row"><div>${esc(name(n.deviceId))}<small class="mono">HOLDER ${esc(shortId(n.holderInstanceId))}</small><small>${esc(n.coordinator==='REACHABLE'?'控制链路证据有效':'控制链路 UNKNOWN')} · ${n.pairs.length} 条方向证据</small></div>${tag(n.level,n.level==='L0'?'good':n.level==='L3'?'neutral':'warn')}</div>`).join('')}</div><div class="network-legend"><span>L0 全部可达</span><span>L1 部分可达</span><span>L2 仅控制可达</span><span>L3 控制未知 / 失联</span></div>`:empty('UNKNOWN · 尚无成对探测证据'));
  const pairs=states.flatMap(n=>n.pairs.map(p=>({...p,holderInstanceId:n.holderInstanceId})));
  const pairRows=pairs.map(p=>{
    const link=snapshot.links.find(l=>l.holderInstanceId===p.holderInstanceId&&(l.direction==='WRITE'?l.deviceId===p.from&&l.endpointDeviceId===p.to:l.endpointDeviceId===p.from&&l.deviceId===p.to));
    const fresh=p.expiresAt>now()&&p.observedAt<=now(),reason=fresh?p.reason:'EVIDENCE_EXPIRED',estimate=reason==='REACHABLE'&&link?.expiresAt>now()?link.estimate:null;
    return `<tr><td>${esc(name(p.from))} <span class="muted">→</span> ${esc(name(p.to))}<small class="mono">HOLDER ${esc(shortId(p.holderInstanceId))}</small></td><td>${tag(reason,reason==='REACHABLE'?'good':'neutral')}</td><td class="mono">${esc(ms(estimate?.fixedMs))}</td><td class="mono">${esc(estimate&&number(estimate.bytesPerSecond)?bytes(estimate.bytesPerSecond)+'/s':'UNKNOWN')}</td><td>${reason==='REACHABLE'?'直连探测可达':'直连未知 / 不可用'}<small>中继选择以任务计划为准</small></td></tr>`;
  });
  const transfers=snapshot?.transfers??[];
  replaceContent('links',(pairRows.length?`<div class="table-wrap"><table><thead><tr><th>方向 / 宿主</th><th>证据状态</th><th>固定开销估计</th><th>带宽估计</th><th>路径说明</th></tr></thead><tbody>${pairRows.join('')}</tbody></table></div>`:empty('尚无链路证据；不预设直连、带宽或延迟'))+(transfers.length?`<details class="workflow-list" data-detail="transfers"><summary>最近直传授权记录（${transfers.length} 条；COMPLETED 表示接收端已确认）</summary><div class="table-wrap"><table><thead><tr><th>任务</th><th>方向</th><th>端点设备</th><th>大小</th><th>状态</th></tr></thead><tbody>${transfers.map(t=>`<tr><td class="mono">${esc(shortId(t.jobId))}</td><td>${esc(t.operation)}</td><td>${esc(name(t.endpointDeviceId))}</td><td>${esc(bytes(t.bytes))}</td><td>${esc(t.state)}</td></tr>`).join('')}</tbody></table></div></details>`:''));
}
const capabilityMarkup=value=>`<span class="capability-name">${esc(capabilityLabel(value))}</span>${Object.hasOwn(capabilities,value)?`<span class="capability-code">${esc(value)}</span>`:''}`;
function renderRecentJobs(){
  const jobs=snapshot?.jobs.slice(0,3)??[];
  replaceContent('recent-jobs',jobs.length?`<div class="recent-grid">${jobs.map(j=>`<button class="recent-task" data-job="${esc(j.id)}"><span class="recent-top">${tag(j.state,stateKind(j.state))}<span class="mono">${esc(date(j.createdAt))}</span></span><strong>${esc(capabilityLabel(j.capability))}<span aria-hidden="true">↗</span></strong><span class="recent-device">${esc(name(j.deviceId))}</span><span class="id">${esc(j.capability)} / ${esc(shortId(j.id))}</span></button>`).join('')}</div>`:empty(snapshot?'暂无执行记录。任务经 SDK 提交后会在此展示。':'等待协调者执行记录'));
}
function renderJobs(){
  const jobs=snapshot?.jobs??[];
  if(!jobs.some(j=>j.id===selected))selected=jobs.find(j=>j.traceOwner)?.id??jobs[0]?.id??'';
  $('job-count').textContent=snapshot?`${jobs.length} / ${snapshot.jobCount} 条`:'UNKNOWN';
  replaceContent('workflows',snapshot?.workflows.length?`<div class="workflow-list">${snapshot.workflows.map(w=>`<details data-detail="${esc(w.id)}"><summary>工作流 ${esc(shortId(w.id))} · ${esc(w.state)} · ${w.nodes.length} 节点</summary>${w.nodes.map(n=>`<p class="mono">${esc(n.id)} → ${esc(shortId(n.jobId))} / ${esc(n.state)}</p>`).join('')}</details>`).join('')}</div>`:'');
  replaceContent('jobs',jobs.length?`<div class="table-wrap"><table><thead><tr><th>任务 / 能力</th><th>执行设备</th><th>状态</th><th>记录时间</th></tr></thead><tbody>${jobs.map(j=>`<tr class="job-row ${j.id===selected?'selected':''}" data-job="${esc(j.id)}"><td><button type="button" class="job-title" aria-pressed="${j.id===selected}" data-job="${esc(j.id)}">${capabilityMarkup(j.capability)}</button><small class="mono">${esc(shortId(j.id))} / ${esc(j.nodeId)}</small></td><td>${esc(name(j.deviceId))}<small class="mono">${esc(shortId(j.targetId))}</small></td><td>${tag(j.state==='QUEUED'?'等待派发':j.state,stateKind(j.state))}${j.queueReason?`<small>${esc(j.queueReason)}</small>`:''}</td><td class="mono">${esc(date(j.createdAt))}</td></tr>`).join('')}</tbody></table></div>`:empty('暂无任务记录。本页不发起或改派任务。'));
}
const contributionReasons={
  LOW_BATTERY:'电量低且未充电',THERMAL_LIMIT:'设备报告过热',POWER_SAVE:'设备处于省电模式',
  BATTERY_LOW_OR_UNKNOWN:'电量或充电状态未满足贡献策略',TEMPERATURE_HIGH_OR_UNKNOWN:'热等级超限或缺少温度证据',
  POWER_SAVE_OR_UNKNOWN:'省电模式开启或状态未知',NO_CREDIT:'当前任务类别没有可用额度'
};
function renderDecision(){
  const job=snapshot?.jobs.find(j=>j.id===selected);
  if(!job){$('decision').innerHTML=empty('选择任务后查看调度证据');$('trace').innerHTML='';return;}
  const p=job.plan,scales=costScale([job.plan?.baselineMs,job.plan?.suggestionMs]),route=job.resultDelivery==='ORIGIN_LOCAL'?'来源本地':job.transfers.length?'派发含中继读取路径':job.selectedInputEndpoint?'规划选择直连端点':'以已有副本 / 追踪证据核对';
  const waits=(p?.suggestion??[]).filter(a=>number(a.policyQueueMs)&&number(a.dagResourceWaitMs));
  const race=job.race;
  const timing=race?.timing;
  const raceDetails=race?`<details class="evidence-details" data-detail="${esc('race-'+job.id)}"><summary>备份执行与结果</summary><p>原尝试 ${esc(shortId(race.primary))} · 备份 ${esc(shortId(race.backup))} · ${race.winner?'已提交 '+esc(shortId(race.winner)):'等待结果'}</p>${timing?`<p>连接异常至评估 ${esc(ms(timing.signalToAssessmentMs))} · 评估至备份派发 ${esc(ms(timing.assessmentToOfferMs))}</p><p>备份派发至胜者提交 ${esc(ms(timing.offerToWinnerMs))} · 提交至双方结算确认 ${esc(ms(timing.winnerToBothSettledMs))}</p>`:''}</details>`:'';
  const assessment=job.recoveryEstimate;
  const recoveryLabels={CONTROL_UNAVAILABLE:'执行设备离线或疑似失联',BACKUP_INPUT_UNAVAILABLE:'缺少可核验的备份输入',WAIT_FOR_PRIMARY:'继续等待原任务',ALTERNATIVE_FASTER:'备选预计更快',NO_FEASIBLE_ALTERNATIVE:'无可行备选',REMAINING_UNKNOWN:'原任务剩余时间未知'};
  const recoveryDetails=assessment?`<details class="evidence-details" data-detail="${esc('slow-'+job.id)}"><summary>执行变慢评估</summary><p>${esc(recoveryLabels[assessment.reason]??assessment.reason)} · 快照 ${esc(assessment.snapshotVersion??'UNKNOWN')}</p><p>原任务预计剩余 ${esc(ms(assessment.remainingMs))} · 备选全路径 ${esc(ms(assessment.alternativeMs))}</p>${assessment.backupRefusal?`<p>备份未启动 · ${esc(assessment.backupRefusal)}</p>`:''}</details>`:'';
  const estimate=p?.suggestion?.[0];
  const costDetails=estimate?.costSource?'<p>执行耗时依据 · '+(estimate.costSource==='MEASURED'?'同条件已提交样本':'设备校准先验')+' · 不确定余量 '+esc(ms(estimate.uncertaintyMs))+'</p>':'';
  const waitDetails=waits.length?`<details class="evidence-details" data-detail="${esc('wait-'+job.id)}"><summary>规划等待明细</summary>${waits.map(a=>`<p>${esc(a.nodeId)} · 策略排队 ${esc(ms(a.policyQueueMs))} · 图内资源竞争 ${esc(ms(a.dagResourceWaitMs))}</p>`).join('')}</details>`:'';
  replaceContent('decision',`<div class="detail-content"><h3>${esc(capabilityLabel(job.capability))}<small>${esc(job.capability)}</small></h3><div class="id">${esc(job.id)}</div><div class="key-value"><span>所选设备</span><strong>${esc(name(job.deviceId))}</strong></div><div class="key-value"><span>候选目标数（资格过滤后）</span><strong>${esc(job.candidateCount??'UNKNOWN')}</strong></div><div class="key-value"><span>数据范围</span><strong>${esc(job.dataScope??'UNKNOWN')}</strong></div><div class="key-value"><span>决策原因</span><strong>${esc(job.reason??'UNKNOWN')}</strong></div><div class="key-value"><span>快照 / 策略</span><strong>${esc(p?p.snapshotVersion+' / '+p.policyVersion:'UNKNOWN')}</strong></div><div class="key-value"><span>路径描述</span><strong>${esc(route)}</strong></div><div class="key-value"><span>资源结算</span><strong>${job.resourcesSettled===null?'UNKNOWN':job.resourcesSettled?'已确认结算':'尚未确认释放'}</strong></div><div class="costs"><div class="cost"><label>基线路径 · 规划估计</label><strong>${esc(ms(p?.baselineMs))}</strong><div class="cost-bar ${scales[0]===null?'unknown':''}">${scales[0]===null?'':`<i style="width:${scales[0]}%"></i>`}</div></div><div class="cost chosen"><label>所选路径 · 规划估计</label><strong>${esc(ms(p?.suggestionMs))}</strong><div class="cost-bar ${scales[1]===null?'unknown':''}">${scales[1]===null?'':`<i style="width:${scales[1]}%"></i>`}</div></div></div><p class="explanation">显示持久化规划结果，不重新计算或选择目标。这里只保留基线与所选方案，不补造其他候选成本；估计不是执行实测。</p>${raceDetails}${recoveryDetails}${costDetails}${waitDetails}${p?.rejections.length?`<details class="rejections" data-detail="${esc(job.id)}"><summary>${p.rejections.length} 条候选拒绝证据</summary>${p.rejections.map(r=>`<p class="mono">${esc(shortId(r.targetId))} · ${esc(contributionReasons[r.code]??r.code)}</p>`).join('')}</details>`:''}</div>`);
}
function renderTrace(){
  if(!selected){$('trace').innerHTML='';return;}
  if(traceError){$('trace').innerHTML=empty(traceError);return;}
  if(!trace){$('trace').innerHTML=empty('正在读取授权追踪…');return;}
  if(!trace.spans.length){$('trace').innerHTML=empty('尚无追踪区间，等待执行端上报。');return;}
  const summary=traceSummary(trace),groups=clockLanes(trace.spans);
  const causalLinks=trace.causality?.links??[],spanById=new Map(trace.spans.map(s=>[s.spanId,s]));
  const dependencyDetails=causalLinks.length?`<details class="evidence-details" data-detail="${esc('causality-'+selected)}"><summary>因果依赖 · ${causalLinks.length} 条</summary><p>已测因果链 ${esc(summary.measuredChain)}；跨端未知间隙未计入，完整关键路径按测量状态展示。</p>${causalLinks.map(link=>`<p>${esc(spanById.get(link.beforeSpanId)?.phase)} ${esc(shortId(link.beforeSpanId))} → ${esc(spanById.get(link.afterSpanId)?.phase)} ${esc(shortId(link.afterSpanId))} · ${esc(link.reason)}</p>`).join('')}</details>`:'';
  const queues=trace.spans.filter(s=>s.phase==='QUEUE'&&s.queueSamples?.length);
  const waitLabels={RESOURCE_CAPACITY:'资源容量不足',OWNER_ACTIVE:'所有者活跃',LOCAL_QUEUE_POLICY:'队列策略',CONTROL_UNAVAILABLE:'控制连接不可用',ADMISSION_SERIALIZATION:'准入串行等待',SELECTED:'已选中',OBSERVATION_LIMIT:'后续采样省略',QUEUE_WAIT_UNKNOWN:'原因未知'};
  const queueDetails=queues.length?`<details class="evidence-details" data-detail="${esc('queue-'+selected)}"><summary>排队与资源结算观测</summary><p>时间从各任务入队起算。结算时间为本机首次观察到确认的时刻。</p>${queues.map(s=>`<p>任务 ${esc(shortId(s.attemptId))}</p>${s.queueSamples.map(q=>`<p>+${esc(ms(q.atMono-s.startMono))} · ${esc(waitLabels[q.reasonCode]??q.reasonCode)}${q.resourcePoolIds.length?' · 资源池 '+esc(q.resourcePoolIds.join('、')):''}${q.occupyingAttempts.length?' · 占用任务 '+esc(q.occupyingAttempts.join('、')):''}${q.settledAttempts.length?' · 已确认结算 '+esc(q.settledAttempts.join('、')):''}</p>`).join('')}`).join('')}</details>`:'';
  const errors=trace.analysis?.predictionErrors??[];
  const costDetails=errors.length?`<details class="evidence-details" data-detail="${esc('costs-'+selected)}"><summary>分段估计与实测 · ${errors.length} 条</summary><p>误差为实测减规划估计；各段独立核对，不合计为端到端收益。</p>${errors.map(row=>`<p>${esc(row.phase)} · 快照 ${esc(row.snapshotVersion)} · 估计 ${esc(ms(row.predictedMs))} / 实测 ${esc(ms(row.measuredMs))} / 误差 ${esc(ms(row.errorMs))}</p>`).join('')}</details>`:'';
  replaceContent('trace',`<div class="trace-content"><div class="trace-head"><span>任务阶段时间线</span>${tag(summary.complete?'测量完整':'测量不完整',summary.complete?'good':'warn')}</div><div class="trace-totals"><div><span>完整端到端</span><strong>${esc(summary.endToEnd)}</strong></div><div><span>完整关键路径</span><strong>${esc(summary.critical)}</strong></div></div><p class="explanation">每个时钟域独立从 0 计时；条形位置表示同域相对起点，长度表示实测耗时。不同域不对齐、不合计。</p>${groups.map((group,i)=>`<section class="clock-chart"><div class="clock-heading"><strong><i class="clock-dot"></i>时钟域 ${i+1}</strong><span>${esc(shortId(group.clockDomainId))} · 独立时间轴</span></div><div class="lane-axis"><span>阶段</span><div><span>0</span><span>${esc(ms(group.extent))}</span></div><span>耗时</span></div>${group.rows.map(({span:s,left,width,offset})=>`<div class="timeline-lane" data-phase="${esc(s.phase)}"><div class="lane-label">${esc(s.reasonCode==='SOURCE_SDK_SUBMIT_TO_VERIFIED_RESULT'?'SDK 端到端':Object.hasOwn(phases,s.phase)?phases[s.phase]:s.phase)}<small>${esc(s.phase)}</small></div><div class="lane-track" role="img" aria-label="${esc(s.phase+'，同域相对起点 '+ms(offset)+'，耗时 '+ms(s.durationMs))}">${offset===null?'<span class="lane-unknown">UNKNOWN</span>':`<i class="lane-bar ${s.durationMs===0?'zero-span':''} ${summary.complete&&trace.analysis.criticalSpanIds.includes(s.spanId)?'critical':''}" style="left:${left}%;width:${width}%" title="${esc('起点 '+ms(offset)+' / '+s.measurementScope+' / '+shortId(s.targetId))}"></i>`}</div><strong class="lane-duration">${esc(ms(s.durationMs))}</strong></div>`).join('')}</section>`).join('')}<div class="timeline-legend"><span><i class="compute-key"></i>执行区间</span><span><i class="data-key"></i>加载 / 发布</span><span><i class="control-key"></i>其他阶段</span><span>细线标记 0 ms 区间</span></div><details class="evidence-details" data-detail="${esc('spans-'+selected)}"><summary>跨度标识与测量范围 · ${trace.spans.length} 条</summary>${groups.map(g=>g.rows.map(({span:s,offset})=>`<p>${esc(s.phase)} · CLOCK ${esc(shortId(s.clockDomainId))} · 起点 ${esc(ms(offset))} · ${esc(s.measurementScope)} · ${esc(shortId(s.targetId))}</p>`).join('')).join('')}</details>${dependencyDetails}${queueDetails}${costDetails}${summary.issues.length?`<div class="issues"><strong>完整链路仍待补齐</strong><span>以下记录保留原始证据，不推算缺失阶段。</span><details data-detail="${esc('issues-'+selected)}"><summary>查看 ${summary.issues.length} 项测量说明</summary>${summary.issues.map(x=>`<p>${esc(x)}</p>`).join('')}</details></div>`:''}</div>`);
}
function renderFaults(){
  const jobs=(snapshot?.jobs??[]).filter(j=>j.rejection||j.yield||['FAILED','REJECTED','SIDE_EFFECT_UNKNOWN','HOLDER_RECORD_MISSING','BUDGET_EXHAUSTED'].includes(j.state));
  const feature=code=>code==='PURE_INTERACTIVE_RELAY_INPUT'?'交互 PURE 任务 · 中继输入已核验':code==='NOT_IMPLEMENTED_S6'?'尚未接入（S6）':code==='AVAILABLE'?'已接入，以事件记录为准':'UNKNOWN';
  $('faults').innerHTML=`<div class="fault-layout"><div>${jobs.length?jobs.slice(0,10).map(j=>`<div class="fault-event"><strong>${esc(j.rejection?.reasonCode??j.yield?.reasonCode??j.state)}</strong><small>${esc(shortId(j.id))} · ${esc(name(j.deviceId))} · ${esc(j.state)} · 资源结算 ${j.resourcesSettled===true?'已确认':'UNKNOWN / 未确认'}</small></div>`).join(''):empty(snapshot?'当前执行记录窗口内无已记录的拒绝、让出或失败事件':'等待协调者记录')}<p class="explanation">画像过期只表示当前证据失效，不直接判定设备故障；结果或取消状态也不代替资源结算证明。</p></div><aside class="unavailable"><h3>故障恢复能力边界</h3><p>备份执行：${feature(snapshot?.features.hedging)}</p><p>故障改派：${feature(snapshot?.features.reassignment)}</p><p>本页展示已有任务状态与让出证据，不生成恢复或改派记录。</p></aside></div>`;
}
function renderApplications(){
  $('applications').innerHTML=(snapshot?.applications??[]).map(a=>`<article class="device-card"><h3>${esc(a.label)}</h3><p>声明版本：${esc(a.declaration?.revision??'未声明')} · 并发额度 ${esc(a.maxConcurrent)}</p><p>${a.contracts.map(esc).join(' · ')}</p>${(a.declaration?.workflows??[]).map(w=>`<p>${esc(w.id)}：${w.capabilities.map(esc).join(' → ')}</p>`).join('')}<p>${a.installations.map(i=>`${esc(shortId(i.deviceId))} · ${esc(i.state)}`).join('<br>')}</p><small>ACTIVE 表示安装身份有效，不代表应用当前在线或执行能力已就绪。</small></article>`).join('')||empty('尚无注册应用');
}
function renderGaps(){
  const gaps=snapshot?.capabilityGaps??[];
  $('capability-gaps').innerHTML=gaps.length?`<div class="table-wrap"><table><thead><tr><th>能力</th><th>需要它的应用</th><th>合格目标</th><th>登记但未就绪</th><th>缺少它的设备</th><th>如何补齐</th></tr></thead><tbody>${gaps.map(g=>`<tr><td><strong>${esc(g.label)}</strong><br><small>${esc(g.capability)}</small></td><td>${g.requiredBy.map(esc).join('<br>')}</td><td><span class="tag ${g.status==='READY'?'good':g.status==='PENDING'?'warn':'bad'}">${g.status==='READY'?esc(g.qualifiedTargets+' 个'):g.status==='PENDING'?'评测中':'无'}</span></td><td>${g.providers.filter(p=>!['CANARY','ACTIVE'].includes(p.state)).map(p=>esc(p.deviceName+' · '+p.state+(p.reasonCode?' · '+p.reasonCode:''))).join('<br>')||'—'}</td><td>${g.missingDevices.map(d=>esc(d.name)).join('<br>')||'—'}</td><td><small>${esc(g.install)}</small></td></tr>`).join('')}</tbody></table></div><small>缺口 = 应用声明 − 设备实际登记并通过评测的能力。调度器不会把任务派给未登记该能力的设备，也不会替任何设备安装东西；安装由设备主人决定，装好后代理自动登记、评测并进入候选。</small>`:empty('所有已声明的能力都有合格目标');
}
function render(){renderRecentJobs();renderMetrics();renderTopology();renderDevices();renderApplications();renderGaps();renderNetwork();renderJobs();renderDecision();renderTrace();renderFaults();}
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
  $('shopping-link').href='shopping.html?space='+encodeURIComponent(id);
  if(location.hostname==='127.0.0.1'){ $('photo-studio-link').href='http://127.0.0.1:7460/';$('photo-studio-link').target='_blank';}else $('photo-studio-link').href='photo.html?space='+encodeURIComponent(id)+'&view=judge';
  stream?.close();group=id;snapshot=null;trace=null;traceError='';selected='';traceSerial++;serverAnchor=0;$('domain').className='tag neutral';$('domain').textContent='UNKNOWN';$('updated').textContent='尚未取得快照';render();
  const requestedUrl=new URL(location.href);if(requestedUrl.searchParams.get('space')===id)selected=requestedUrl.searchParams.get('job')||'';
  const url=new URL(location.href);if(id)url.searchParams.set('space',id);else url.searchParams.delete('space');history.replaceState(null,'',url);
  if(!id){connection('未选择空间');notice('请选择一个已加入的空间；接入设备与提交任务请使用控制台。');return;}
  connection('正在连接');notice('正在读取协调者快照…');void refresh();
  const source=new EventSource(`/v2/spaces/${encodeURIComponent(group)}/events`);stream=source;
  source.onopen=()=>{if(stream!==source)return;connection('实时事件已连接','good');schedule();};
  source.addEventListener('changed',()=>{if(stream===source)schedule();});
  source.onerror=()=>{if(stream!==source)return;document.querySelector('main').classList.add('stale-data');connection('事件连接中断','warn');notice('事件连接中断，内容可能过期；正在等待重连。',true);};
}
$('space').addEventListener('change',e=>selectSpace(e.target.value));$('refresh').addEventListener('click',()=>void refresh());
document.addEventListener('click',e=>{const device=e.target.closest('[data-device]');if(device){navigate('resources');const card=[...document.querySelectorAll('[data-device-card]')].find(el=>el.dataset.deviceCard===device.dataset.device);card?.focus({preventScroll:true});card?.scrollIntoView({block:'nearest'});return;}const row=e.target.closest('[data-job]');if(!row||!snapshot?.jobs.some(j=>j.id===row.dataset.job))return;if(location.hash!=='#tasks')navigate('tasks');selected=row.dataset.job;trace=null;traceError='';renderJobs();renderDecision();renderTrace();void loadTrace();});
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
