export const isPhotoDraft=r=>r?.kind==='LOCAL'&&['PICKING','SELECTED'].includes(r.state);
export const roundDevices=r=>[...new Set((r.devices??[]).map(d=>d.name||d.id).filter(Boolean))].join(' · ')||(r.kind==='LOCAL'?'手机 CPU':'等待执行回执');
export function displayRounds(data){
 const runs=(data.runs??[]).filter(r=>!isPhotoDraft(r));
 const drafts=[...(data.runs??[]).filter(isPhotoDraft),...(data.preview?[data.preview]:[])].sort((a,b)=>b.createdAt-a.createdAt);
 const preview=drafts.find(r=>r.createdAt>(runs[0]?.createdAt??-1));
 return {runs,preview};
}
export function comparison(a,b){
 if(!a||!b)return {reason:'完成两轮后，可在这里比较处理耗时。'};
 if(a.state!=='SUCCEEDED'||b.state!=='SUCCEEDED')return {reason:'未完成的轮次不参与速度比较。'};
 if(a.kind==='SIMULATED'||b.kind==='SIMULATED')return {reason:'本机进程验证不代表多设备性能。'};
 const inputs=r=>r.inputs.map(i=>[i.originalHash||i.hash,i.width,i.height]);
 if(JSON.stringify(inputs(a))!==JSON.stringify(inputs(b)))return {reason:'两轮的照片、顺序或尺寸不同，耗时仅并列展示，不计算提速倍数。'};
 if(!a.budgetMs||!b.budgetMs||!a.model?.weightsHash||!b.model?.weightsHash)return {reason:'原图相同；旧版本机记录未上报预算或模型信息，耗时可回看，暂不计算严格提速倍数。'};
 if(a.budgetMs!==b.budgetMs||a.model.weightsHash!==b.model.weightsHash||a.scale!==b.scale)return {reason:'两轮预算、模型或倍率不同，不计算提速倍数。'};
 if(!(a.durationMs>0&&b.durationMs>0))return {reason:'等待有效的完成耗时。'};
 return {ratio:a.durationMs/b.durationMs,reason:'同原图、同预算、同模型；耗时为 App 上报的端到端实测，包含通信与调度。'};
}
