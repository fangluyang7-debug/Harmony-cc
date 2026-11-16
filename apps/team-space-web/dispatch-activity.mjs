import {escapeHtml as esc,bytes,number} from './dispatch-view.mjs';
const phases={PREPARING:'准备',AUTHORIZING:'应用授权',PROBING:'云端能力与网络探测',CLOUD_REQUEST:'请求云端购物服务',BUSINESS_COMPUTE:'商品计算',FINISHED:'已结束'};
const operations={text:'文字检索',image_upload:'图片检索',prices:'比价',more:'更多商品',refine:'调整检索',turn:'购物对话',read:'读取会话',answer:'继续提问',subject:'识别商品',profile:'商品画像'};
const states={RUNNING:'进行中',SUCCEEDED:'成功',FAILED:'失败',CANCELLED:'已取消',TIMED_OUT:'超时'};
export function appActivityMarkup(observations,applications,now){
 return (observations??[]).filter(o=>now-o.receivedAt<15000&&now-o.activity.sampledAt<15000).map(o=>{
  const a=o.activity,label=applications?.find(x=>x.id===o.appId)?.label??'业务应用';
  // hidebug ratio: show application-process usage, never device-wide CPU or resource slots.
  const cpu=number(a.processCpuUsage)?`${(a.processCpuUsage*100).toFixed(1)}%`:'UNKNOWN';
  const tasks=[...a.tasks].sort((x,y)=>y.updatedAt-x.updatedAt).slice(0,3);
  return `<section class="holder"><h4>${esc(label)} · 实时业务状态</h4><div class="device-signals"><div class="signal"><label>应用进程 CPU</label><strong>${esc(cpu)}</strong></div><div class="signal"><label>应用内存 PSS</label><strong>${esc(bytes(a.processMemoryBytes))}</strong></div></div>${tasks.map(t=>`<p><strong>${esc(operations[t.operation]??t.operation)} · ${esc(states[t.state]??t.state)}</strong> · ${esc(phases[t.phase]??t.phase)}${t.error?` · ${esc(t.error)}`:''}<br><span class="id">${esc(t.taskId)}</span></p>`).join('')}<p class="explanation">应用上报的业务状态；云端等待不等于本机计算。跨设备执行以调度回执为准。</p></section>`;
 }).join('');
}

// Retain actual job evidence after short-lived quota occupation has returned to zero.
// This is history from the coordinator, never a synthetic utilisation sample.
export function deviceExecutionMarkup(deviceId,jobs,label=value=>value){
 const own=(jobs??[]).filter(j=>j.deviceId===deviceId);
 const completed=own.filter(j=>['SUCCEEDED','COMMITTED'].includes(j.state));
 const settled=completed.filter(j=>j.resourcesSettled===true);
 const recent=[...own].sort((a,b)=>(b.createdAt??0)-(a.createdAt??0)).slice(0,3);
 const states={SUCCEEDED:'执行成功',COMMITTED:'结果已提交',RUNNING:'执行中',ACCEPTED:'已接收',DISPATCHED:'已派发',QUEUED:'排队中',REJECTED:'已拒绝',FAILED:'执行失败'};
 return `<section class="holder"><h4>本设备执行记录</h4><div class="device-signals"><div class="signal"><label>当前历史窗口 · 成功任务</label><strong>${completed.length}</strong></div><div class="signal"><label>其中资源已释放</label><strong>${settled.length}</strong></div></div><p class="explanation">下方圆环是采样时的任务额度占用，不是 CPU 使用率或应用内存。短任务可能在两次采样之间完成；归零后仍可通过执行记录核对。</p>${recent.map(j=>`<button type="button" class="recent-task" data-job="${esc(j.id)}"><strong>${esc(label(j.capability))} · ${esc(states[j.state]??j.state)}</strong><span>${j.originDeviceId===deviceId?'手机/设备自身执行':j.originDeviceId?'来自其他设备的任务':'来源设备未记录'} · ${j.resourcesSettled===true?'资源已结算':'结算待确认'}</span><span class="id">${esc(j.id)}</span><span>查看实际目标与阶段耗时 ↗</span></button>`).join('')||'<p class="explanation">当前历史窗口暂无派发到本设备的任务；等待云端检索时不占用本设备的协同额度。</p>'}<p class="explanation">仅统计协调中心返回的近期记录，非全量累计；派发与拒绝不计作执行成功。</p></section>`;
}
