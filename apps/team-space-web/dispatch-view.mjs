export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const shortId=value=>value?String(value).slice(0,8):'UNKNOWN';
export const number=value=>typeof value==='number'&&Number.isFinite(value);
export function bytes(value){if(!number(value))return 'UNKNOWN';if(value<1024)return `${value} B`;if(value<1048576)return `${(value/1024).toFixed(1)} KiB`;if(value<1073741824)return `${(value/1048576).toFixed(1)} MiB`;return `${(value/1073741824).toFixed(2)} GiB`;}
export const ms=value=>number(value)?`${value.toFixed(value<10?2:1)} ms`:'UNKNOWN';
export function sample(sample,now){
  if(!sample||sample.value===null||sample.value===undefined||sample.source==='UNKNOWN')return {text:'UNKNOWN',value:null,reason:'未采集'};
  if(!number(sample.sampledAt)||!number(sample.ttlMs)||sample.sampledAt>now||sample.sampledAt+sample.ttlMs<=now)return {text:'UNKNOWN',value:null,reason:'证据已过期或时间无效'};
  const v=sample.value,unit=sample.unit;
  const text=unit==='bytes'?bytes(v):unit==='ms'?ms(v):unit==='percent'?`${v}%`:unit==='level'?`${v} 级`:unit==='slots'?`${v} 槽位`:unit==='bytes_per_second'?`${bytes(v)}/s`:unit==='state'?String(v):`${v}${unit?' '+unit:''}`;
  return {text,value:v,reason:sample.source};
}
export function traceSummary(trace){
  if(!trace?.analysis)return {complete:false,endToEnd:'UNKNOWN',critical:'UNKNOWN',issues:[]};
  const complete=trace.analysis.status==='COMPLETE'&&trace.coverage?.sourceSdkRoot===true&&trace.coverage?.criticalPathPending!==true&&trace.causality?.complete!==false;
  const issues=[...(trace.analysis.issues??[]),...(trace.causality?.missing??[])];if(trace.coverage?.criticalPathPending===true)issues.push(trace.coverage?.reasonCode??'CRITICAL_PATH_DEPENDENCIES_INCOMPLETE');if(trace.coverage?.sourceSdkRoot!==true)issues.push(trace.coverage?.reasonCode??'SOURCE_SDK_ROOT_UNKNOWN');
  const conflict=issues.some(i=>['CAUSAL_CYCLE','CAUSAL_OVERLAP','TRANSFER_CAUSAL_CONFLICT','NEGATIVE_RESIDUAL'].includes(i));
  return {complete,endToEnd:number(trace.coverage?.sourceDurationMs)?ms(trace.coverage.sourceDurationMs):complete?ms(trace.analysis.endToEndMs):'UNKNOWN',critical:complete?ms(trace.analysis.criticalPathMs):'UNKNOWN',
    measuredChain:!conflict&&trace.causality?.links?.length&&number(trace.analysis.measuredCriticalMs)?ms(trace.analysis.measuredCriticalMs):'UNKNOWN',issues:[...new Set(issues)]};
}
export function traceGroups(spans){
  const groups=new Map();for(const span of spans){if(!groups.has(span.clockDomainId))groups.set(span.clockDomainId,[]);groups.get(span.clockDomainId).push(span);}
  return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([clockDomainId,items])=>({clockDomainId,spans:[...items].sort((a,b)=>a.startMono-b.startMono||a.spanId.localeCompare(b.spanId))}));
}


// GPU temperature is a sensor reading, never a fabricated system thermal level.
export function deviceSignals(profile,observation,now){
 const native=(label,value)=>({label,...sample(value,now)});
 const values=[native('所有者活动',profile.ownerActivity)];
 const live=observation?.holderInstanceId===profile.holderInstanceId&&now-observation.receivedAt<15000&&now-observation.sample?.sampledAt<15000;
 if(!live)return [...values,native('电量',profile.battery),native('温度 / 热等级',profile.temperature)];
 const s=observation.sample;
 const metric=(label,value,unit,reason)=>({label,value,text:value===null?'未采集到':`${Number(value.toFixed(1))}${unit}`,reason});
 const sensorFresh=s.sensorSampledAt>0&&now-s.sensorSampledAt<60000;
 const power={NO_BATTERY:'无电池 · 不适用',CHARGING:'正在充电',DISCHARGING:'电池供电',AC_POWER:'外接电源',UNKNOWN:'系统未提供供电状态'};
 values.push(sensorFresh?{label:'电池 / 供电',value:s.batteryPercent??(s.powerStatus==='UNKNOWN'?null:s.powerStatus),text:s.powerStatus==='NO_BATTERY'?power.NO_BATTERY:s.batteryPercent===null?power[s.powerStatus]:`${s.batteryPercent}% · ${power[s.powerStatus]}`,reason:'Windows 电池传感器'}:{label:'电池 / 供电',value:null,text:'等待电源采样',reason:'电源采样尚未返回或已过期'});
 const thermal=sample(profile.temperature,now);
 values.push(thermal.value!==null?{label:'系统热等级',...thermal}:{label:'系统热等级',value:null,text:'系统未提供',reason:'Windows 未提供统一的整机热等级；GPU 温度独立显示'});
 values.push(metric('CPU 实测负载',s.cpuPercent,'%', '整机 CPU 时间差采样，不是协同槽位占用'));
 if(s.gpuName||s.gpuTemperatureC!==null||s.gpuPercent!==null){
  values.push(metric('GPU 温度',s.gpuTemperatureC,' °C',`${s.gpuName} · NVIDIA 温度传感器`));
  values.push(metric('GPU 实测负载',s.gpuPercent,'%',`${s.gpuName} · NVIDIA 周期采样，短任务可能落在采样间隙`));
 }
 return values;
}
