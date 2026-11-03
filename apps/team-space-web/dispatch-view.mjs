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
  const complete=trace.analysis.status==='COMPLETE'&&trace.coverage?.sourceSdkRoot===true;
  const issues=[...(trace.analysis.issues??[])];if(trace.coverage?.sourceSdkRoot!==true)issues.push(trace.coverage?.reasonCode??'SOURCE_SDK_ROOT_UNKNOWN');
  return {complete,endToEnd:complete?ms(trace.analysis.endToEndMs):'UNKNOWN',critical:complete?ms(trace.analysis.criticalPathMs):'UNKNOWN',issues};
}
export function traceGroups(spans){
  const groups=new Map();for(const span of spans){if(!groups.has(span.clockDomainId))groups.set(span.clockDomainId,[]);groups.get(span.clockDomainId).push(span);}
  return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([clockDomainId,items])=>({clockDomainId,spans:[...items].sort((a,b)=>a.startMono-b.startMono||a.spanId.localeCompare(b.spanId))}));
}
