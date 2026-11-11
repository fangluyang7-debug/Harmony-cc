export const stageLabels={'photo.analyze.v1':'分析与校正','photo.prepare.v1':'图块准备','photo.enhance.v1':'AI 高清增强','photo.assemble.v1':'合成与校验','photo.deliver.v1':'成品与预览'};
export function tilePlan(width,height){
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>1048576||Math.max(width,height)>1920)throw Error('目前支持不超过 100 万像素、长边不超过 1920 像素的输入照片，请选择原始小图。');
 // Bound graph size. Native inference separately bounds tensor tile size. Placement is still chosen from measured target costs.
 const edge=Math.max(64,Math.ceil(Math.max(width,height)/2));const tiles=[];
 for(let y=0;y<height;y+=edge)for(let x=0;x<width;x+=edge)tiles.push({x,y,width:Math.min(edge,width-x),height:Math.min(edge,height-y)});
 return {tiles,reason:`按输入 ${width} × ${height} 像素和工作流节点数约束生成 ${tiles.length} 个无重叠核心区域；边界附加 16 像素上下文。设备位置由协调者按成本选择。`};
}
export function photoWorkflow(id,input,width,height){
 const {tiles,reason}=tilePlan(width,height),nodes=[{id:'analyze',capability:'photo.analyze.v1',input,parameters:JSON.stringify({width,height}),dependsOn:[]}];
 tiles.forEach((rect,i)=>{const iw=Math.min(width,rect.x+rect.width+16)-Math.max(0,rect.x-16),ih=Math.min(height,rect.y+rect.height+16)-Math.max(0,rect.y-16);nodes.push({id:'enhance-'+i,capability:'photo.enhance.v1',inputFrom:'analyze',parameters:JSON.stringify({...rect,pixels:iw*ih}),dependsOn:['analyze']});});
 const sources=tiles.map((_,i)=>'enhance-'+i);nodes.push({id:'deliver',capability:'photo.deliver.v1',inputFroms:sources,parameters:JSON.stringify({width:width*4,height:height*4,assemble:true}),dependsOn:sources});
 return {workflow:{version:3,id,qualityTarget:'reference',outputContract:'photo.product',nodes},tiles,reason};
}
export function photoPort(group,fetcher,digest,onStatus=()=>{},sourceDeviceId=''){
 const base='/v2/spaces/'+encodeURIComponent(group),jobs=new Map(),domain='photo-browser-'+crypto.randomUUID();
 async function checked(url,options={}){const scoped=url+(sourceDeviceId?(url.includes('?')?'&':'?')+'source='+encodeURIComponent(sourceDeviceId):'');const r=await fetcher(scoped,{credentials:'same-origin',signal:AbortSignal.timeout(60000),...options});if(!r.ok){let error='HTTP_'+r.status;try{error=(await r.json()).error??error;}catch{}throw Error(error);}return r;}
 return {request:async(route,body)=>{const value=await(await checked(base+route.replace('/v2/sdk','/sdk'),{method:body===null?'GET':'POST',headers:{'Content-Type':'application/json'},body:body??undefined})).json();
  for(const t of value.inputTickets??(value.inputTicket?[value.inputTicket]:[]))jobs.set(t.ref.artifactId,value.jobId);
  if(value.outputTicket)jobs.set(value.outputTicket.ref.artifactId,value.jobId);
  if(body===null)onStatus(value);return JSON.stringify(value);},
 write:async(ticket,input)=>{const id=jobs.get(ticket.ref.artifactId);if(!id)throw Error('PHOTO_TICKET_SCOPE');await checked(base+'/sdk/jobs/'+encodeURIComponent(id)+'/input?artifact='+encodeURIComponent(ticket.ref.artifactId),{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:input});},
 read:async ticket=>{const id=jobs.get(ticket.ref.artifactId);if(!id)throw Error('PHOTO_TICKET_SCOPE');return new Uint8Array(await(await checked(base+'/sdk/jobs/'+encodeURIComponent(id)+'/output')).arrayBuffer());},
 digest,now:Date.now,measure:()=>({clockDomainId:domain,milliseconds:performance.now()}),wait:ms=>new Promise(r=>setTimeout(r,ms))};
}
export function comparable(a,b){return a?.domain==='REAL'&&b?.domain==='REAL'&&a?.state==='SUCCEEDED'&&b?.state==='SUCCEEDED'&&a.sourceDurationMs>0&&b.sourceDurationMs>0&&JSON.stringify(a.inputs.map(i=>i.hash))===JSON.stringify(b.inputs.map(i=>i.hash))&&a.budgetMs===b.budgetMs&&!!a.model&&JSON.stringify(a.model)===JSON.stringify(b.model)&&a.scale===b.scale&&a.precision===b.precision&&!!a.sourceDeviceId&&a.sourceDeviceId===b.sourceDeviceId;}
