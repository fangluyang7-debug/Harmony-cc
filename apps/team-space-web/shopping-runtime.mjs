// Business orchestration only. Every compute partition goes through SchedulerSdk.
export const shoppingOrigin='https://api-server-production-0135.up.railway.app';
export const capability='catalog.filter.v1';
// Catalog filtering is a tiny linear pass. Fill one executor's supported batch
// before adding dispatch/transfer overhead; coverage remains an explicit demo mode.
export function catalogPartitionCount(itemCount,readyDevices,mode){
 if(!Number.isInteger(itemCount)||itemCount<0||itemCount>40000||!Number.isInteger(readyDevices)||readyDevices<1)throw Error('候选数量或可用设备数量无效');
 const required=Math.max(1,Math.ceil(itemCount/10000));
 if(mode==='auto')return required;
 if(mode!=='coverage'||readyDevices>4||required>readyDevices)throw Error('分片模式无效');
 return Math.max(required,readyDevices);
}
export function budgetMinor(value){if(!/^\d{1,7}(\.\d{1,2})?$/.test(String(value)))throw Error('请输入有效的人民币预算');const [whole,fraction='']=String(value).split('.');return Number(whole)*100+Number((fraction+'00').slice(0,2));}
export function candidatesFrom(data){
 if(!/^run_[A-Za-z0-9_-]+$/.test(data?.runtimeRunId)||!Array.isArray(data.candidates?.items))throw Error('购物服务未返回有效候选集');
 const seen=new Set();return data.candidates.items.map((item,rank)=>{
  if(!item||typeof item.candidateItemId!=='string'||!item.candidateItemId||seen.has(item.candidateItemId)||typeof item.title!=='string'||!item.price||!/^\d{1,9}(\.\d{1,2})?$/.test(String(item.price.amount))||typeof item.price.currency!=='string')throw Error('商品候选数据不完整');
  seen.add(item.candidateItemId);return {...item,rank};
 });
}
export function partitionCandidates(items,count,maxPriceMinor){
 if(!Number.isInteger(count)||count<1||count>4)throw Error('分片数无效');
 return Array.from({length:Math.min(count,items.length)},(_,part)=>({currency:'CNY',maxPriceMinor,items:items.filter((_,i)=>i%Math.min(count,items.length)===part).map(p=>({id:p.candidateItemId,price:String(p.price.amount),currency:p.price.currency,rank:p.rank}))}));
}
export function mergePartitions(candidates,parts,maxPriceMinor){
 const byId=new Map(candidates.map(p=>[p.candidateItemId,p])),seen=new Set();let scanned=0,excluded=0;const ranked=[];
 for(const part of parts){if(!part||!Number.isSafeInteger(part.scanned)||!Number.isSafeInteger(part.excluded)||part.scanned<0||part.excluded<0||!Array.isArray(part.items)||part.scanned!==part.excluded+part.items.length)throw Error('分片结果不完整');scanned+=part.scanned;excluded+=part.excluded;
  for(const r of part.items){const original=byId.get(r.id);if(!original||seen.has(r.id)||r.rank!==original.rank||!Number.isSafeInteger(r.priceMinor)||r.priceMinor<0||r.priceMinor>maxPriceMinor||original.price.currency!=='CNY')throw Error('分片结果校验失败');
   const [whole,fraction='']=String(original.price.amount).split('.');if(r.priceMinor!==Number(whole)*100+Number((fraction+'00').slice(0,2)))throw Error('价格精度校验失败');seen.add(r.id);ranked.push(r);}
 }
 if(scanned!==candidates.length)throw Error('候选集存在遗漏或重复分片');
 ranked.sort((a,b)=>a.priceMinor-b.priceMinor||a.rank-b.rank||(a.id<b.id?-1:1));
 return {scanned,excluded,items:ranked.map(r=>({...byId.get(r.id),priceMinor:r.priceMinor}))};
}
export function spacePort(group,fetcher,digest,onStatus=()=>{}){
 const base='/v2/spaces/'+encodeURIComponent(group);
 const clockDomainId='shopping-browser-'+crypto.randomUUID();
 async function checked(url,options){const r=await fetcher(url,{credentials:'same-origin',...options});if(!r.ok){let code='HTTP_'+r.status;try{code=(await r.json()).error||code;}catch{}throw Error(code);}return r;}
 return {
  request:async(route,body)=>{const r=await checked(base+route.replace('/v2/sdk','/sdk'),{method:body===null?'GET':'POST',headers:body===null?{}:{'Content-Type':'application/json'},body});const value=await r.text();if(body===null&&/^\/v2\/sdk\/jobs\/[^/]+$/.test(route))onStatus(JSON.parse(value));return value;},
  write:async(ticket,input)=>{await checked(base+'/sdk/jobs/'+encodeURIComponent(ticket.ref.artifactId.slice(3))+'/input',{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:input});},
  read:async ticket=>new Uint8Array(await(await checked(base+'/sdk/jobs/'+encodeURIComponent(ticket.ref.artifactId.slice(4))+'/output',{})).arrayBuffer()),
  digest,now:Date.now,measure:()=>({clockDomainId,milliseconds:performance.now()}),wait:ms=>new Promise(r=>setTimeout(r,ms))
 };
}
