/** Platform-neutral photo orchestration. All execution still enters CoordinatorJobs. */
export interface NativePhotoPort {call(operation:string,payload:string):Promise<string>; id():string; now():number;}
export class NativePhotoEngine {
 private summaries=new Map<string,{revision:number;at:number;devices:string[]}>();
 private active=new Set<string>(); private locks=new Map<string,Promise<any>>();
 constructor(private port:NativePhotoPort){}
 private async call(op:string,data:any={}){return JSON.parse(await this.port.call(op,JSON.stringify(data)));}
 private async get(key:string){return this.call('get',{key});}
 private async save(key:string,value:any){await this.call('put',{key,value});}
 private async lock<T>(key:string,work:()=>Promise<T>):Promise<T>{const previous=this.locks.get(key)??Promise.resolve(),next=previous.catch(()=>{}).then(work);this.locks.set(key,next);try{return await next;}finally{if(this.locks.get(key)===next)this.locks.delete(key);}}
 private owns(peer:any,g:any){if(!g||g.peer.groupId!==peer.groupId||g.peer.holderInstanceId!==peer.holderInstanceId||g.peer.app?.appInstanceId!==peer.app?.appInstanceId)throw Error('JOB_SCOPE');}
 async sdk(peerJson:string,path:string,bodyJson:string):Promise<string>{const peer=JSON.parse(peerJson),body=bodyJson?JSON.parse(bodyJson):null;return JSON.stringify(await this.sdkValue(peer,path,body));}
 private async sdkValue(peer:any,path:string,body:any){
  if(path==='/v2/sdk/jobs'){
   const w=body?.workflow,o=body?.options;if(!peer.app||!w||w.version!==3||!Array.isArray(w.nodes)||w.nodes.length<2||w.nodes.length>32||!/^[A-Za-z0-9_.:-]{1,80}$/.test(o?.requestId)||!(o.budgetMs>0&&o.budgetMs<=300000)||o.resultDestination!=='ORIGIN')throw Error('SDK_WORKFLOW_INVALID');
   const key='graph:'+o.requestId;
   return this.lock(key,async()=>{let g=await this.get(key);if(g){this.owns(peer,g);if(JSON.stringify(g.workflow)!==JSON.stringify(w))throw Error('JOB_CONFLICT');return g.plan;}
    const known=new Set<string>();for(const n of w.nodes){if(!/^[A-Za-z0-9_-]{1,40}$/.test(n.id)||known.has(n.id)||!Array.isArray(n.dependsOn)||n.dependsOn.some((x:string)=>!known.has(x))||!peer.app.allowedContracts.includes(n.capability)||typeof n.parameters!=='string')throw Error('SDK_GRAPH_NODE_INVALID');JSON.parse(n.parameters);if(n.inputFrom&&!n.dependsOn.includes(n.inputFrom)||n.inputFroms?.some((x:string)=>!n.dependsOn.includes(x)))throw Error('SDK_GRAPH_EDGE_INVALID');known.add(n.id);}
    const roots=w.nodes.filter((n:any)=>n.input);if(roots.length!==1||roots[0].dependsOn.length||w.nodes.some((n:any)=>[!!n.input,!!n.inputFrom,!!n.inputFroms].filter(Boolean).length!==1))throw Error('SDK_GRAPH_ROOT_INVALID');
    const root=roots[0],input=await this.call('artifact',{peer,input:root.input,id:'in-'+o.requestId});
    const originLocal=o.inputLocation==='ORIGIN'&&root.executionScope==='ORIGIN_DEVICE';
    const plan={jobId:o.requestId,targetId:'',deviceId:peer.deviceId,reason:'NATIVE_DAG_PLANNING',inputDelivery:originLocal?'LOCAL':'RELAY',inputTicket:input.ticket};
    g={peer,originLocal,workflow:w,options:o,input:input.descriptor,plan,state:'WAITING_INPUT',deadlineAt:this.port.now()+o.budgetMs,createdAt:this.port.now(),nodes:w.nodes.map((n:any)=>({id:n.id,jobId:o.requestId+'.'+n.id,state:'PENDING'}))};await this.save(key,g);return plan;
   });
  }
  const match=/^\/v2\/sdk\/jobs\/([A-Za-z0-9_.:-]+)(?:\/(start|cancel|received))?$/.exec(path);if(!match)throw Error('SDK_ROUTE_INVALID');const key='graph:'+match[1],action=match[2];
  if(action==='start')return this.lock(key,async()=>{const g=await this.get(key);this.owns(peer,g);if(g.state==='WAITING_INPUT'){if(!g.originLocal&&!await this.call('available',{descriptor:g.input}))throw Error('INPUT_NOT_UPLOADED');g.state='ACTIVE';await this.save(key,g);}this.active.add(match[1]);setTimeout(()=>{void this.advance(match[1]).catch(()=>{});},0);return {jobId:match[1]};});
  if(action==='cancel')return this.lock(key,async()=>{const g=await this.get(key);this.owns(peer,g);if(!['SUCCEEDED','FAILED','CANCELLED'].includes(g.state)){g.state='CANCEL_REQUESTED';await this.save(key,g);this.active.add(match[1]);}return {jobId:match[1],state:g.state};});
  const g=await this.get(key);this.owns(peer,g);if(action==='received'){if(g.state!=='SUCCEEDED'||body?.ref?.contentHash!==g.output?.ref.contentHash||body.bytes!==g.output?.bytes)throw Error('RESULT_ACK_INVALID');return {acknowledged:true};}
  return {jobId:match[1],state:g.state==='ACTIVE'?'RUNNING':g.state,deviceId:g.nodes.at(-1)?.target?.deviceId??peer.deviceId,targetId:g.nodes.at(-1)?.target?.targetId??'',outputTicket:g.state==='SUCCEEDED'?await this.call('ticket',{peer,descriptor:g.output}):null,error:g.error??null};
 }
 async restore():Promise<void>{for(const g of await this.call('list',{prefix:'graph:'}))if(['ACTIVE','CANCEL_REQUESTED'].includes(g.state))this.active.add(g.options.requestId);}
 async tick():Promise<void>{await Promise.all([...this.active].map(id=>this.advance(id).catch(()=>{})));}
 private async advance(id:string){if(this.locks.has('graph:'+id))return;await this.lock('graph:'+id,async()=>{
  const g=await this.get('graph:'+id);if(!g)return;const before=JSON.stringify(g),peer=g.peer,now=this.port.now();
  if(now>=g.deadlineAt&&g.state==='ACTIVE'){g.state='CANCEL_REQUESTED';g.error='BUDGET_EXHAUSTED';}
  if(g.state==='CANCEL_REQUESTED'){await Promise.all(g.nodes.filter((s:any)=>s.state==='SUBMITTED').map((s:any)=>this.call('cancel',{peer,id:s.jobId}).catch(()=>{})));g.state=g.error?'FAILED':'CANCELLED';this.active.delete(id);await this.save('graph:'+id,g);return;}
  if(g.state!=='ACTIVE'){this.active.delete(id);return;}
  // Independent siblings and workflows advance concurrently; resource admission remains in Jobs.
  const submitted=g.nodes.filter((s:any)=>s.state==='SUBMITTED'),observed=submitted.length?await this.call('inspectMany',{peer,ids:submitted.map((s:any)=>s.jobId)}):[];
  await Promise.all(submitted.map(async(s:any,index:number)=>{
   const j=observed[index];s.target=j.offer?.target;s.reason=j.offer?.reasonCode;s.decision=j.decision?JSON.parse(j.decision):null;s.executionState=j.state;
   if(j.state==='SUCCEEDED'&&j.output){s.state='COMMITTED';s.output=j.output;return;}
   const unstarted=j.state==='REJECTED'&&j.rejection?.record===null&&['RESOURCE_UNAVAILABLE','CREDIT_UNAVAILABLE','QUEUE_STARVED_NOT_STARTED','COORDINATOR_OFFLINE','AGENT_NOT_READY','CONTROL_UNAVAILABLE'].includes(j.rejection?.reasonCode);
   const restart=['CANCELLED_SETTLED','YIELDED'].includes(j.state)&&j.restartable===true;
   if(g.state==='ACTIVE'&&(unstarted||restart)&&(s.retries??0)<8&&this.port.now()<g.deadlineAt){
    const reason=restart?j.yieldNotice?.reasonCode??j.state:j.rejection.reasonCode;
    s.attempts=[...(s.attempts??[]),{jobId:s.jobId,state:j.state,reason}];s.retries=(s.retries??0)+1;s.jobId=id+'.'+s.id+'.r'+s.retries;s.state='PENDING';s.executionState='PENDING';
    s.retryAt=this.port.now()+Math.min(1000,100*s.retries);s.waitReason=reason;return;
   }
   if(['FAILED','REJECTED','CANCELLED','CANCELLED_SETTLED','YIELDED','SIDE_EFFECT_UNKNOWN','HOLDER_RECORD_MISSING'].includes(j.state)){g.state='CANCEL_REQUESTED';g.error='NODE_'+s.id+'_'+j.state;}
  }));
  if(g.state==='ACTIVE')for(const n of g.workflow.nodes){const s=g.nodes.find((x:any)=>x.id===n.id);if(s.state!=='PENDING'||(s.retryAt??0)>this.port.now()||n.dependsOn.some((d:string)=>g.nodes.find((v:any)=>v.id===d).state!=='COMMITTED'))continue;
   try{
    let source=n.input?g.input:n.inputFrom?g.nodes.find((x:any)=>x.id===n.inputFrom).output:s.input;
    if(!source){source=await this.call('bundle',{peer,id:'bundle-'+s.jobId,parts:n.inputFroms.map((d:string)=>({nodeId:d,descriptor:g.nodes.find((x:any)=>x.id===d).output}))});s.input=source;}
    const contract=await this.call('contract',{capability:n.capability});
    const child={...n,input:{...source.ref,bytes:source.bytes},dependsOn:[]};delete child.inputFrom;delete child.inputFroms;delete child.input.artifactId;delete child.input.contentVersion;
    const submission={workflow:{version:3,id:s.jobId,outputContract:contract.contract.outputSchemas[0],qualityTarget:'reference',nodes:[child]},options:{...g.options,requestId:s.jobId,budgetMs:Math.max(1,Math.floor(g.deadlineAt-this.port.now()))}};
    const result=await this.call('dispatch',{peer,submission,source,sourceLocal:!!g.originLocal&&!!n.input});s.target=result.target;s.state='SUBMITTED';
   }catch(e){const error=(e as Error).message;if(!['NO_LEGAL_PLAN','INPUT_NOT_UPLOADED','BUDGET_UNAVAILABLE','TARGET_UNAVAILABLE'].includes(error)){g.state='CANCEL_REQUESTED';g.error=error;}s.waitReason=error;}
  }
  if(g.nodes.every((s:any)=>s.state==='COMMITTED')){g.state='SUCCEEDED';g.output=g.nodes.at(-1).output;this.active.delete(id);}
  if(JSON.stringify(g)!==before)await this.save('graph:'+id,g);
 });}
 async photo(peerJson:string,inputJson:string):Promise<string>{const peer=JSON.parse(peerJson),m=JSON.parse(inputJson);if(!peer.app?.allowedContracts.includes('photo.enhance.v1'))throw Error('PHOTO_APP_REQUIRED');if(m.route.startsWith('/photo-large-runs'))return this.largePhoto(peer,m);const match=/^\/photo-runs(?:\/([A-Za-z0-9-]+)(?:\/(input|capture-result|result)\?image=(\d+))?)?$/.exec(m.route);if(!match)throw Error('PHOTO_ROUTE_INVALID');let id=match[1];
  if(!id){if(m.method==='POST'){const b=m.body;if(!Array.isArray(b.inputs)||!b.inputs.length||b.inputs.length>8||b.mode!=='COOPERATIVE'||!Number.isInteger(b.budgetMs)||b.budgetMs<1||b.budgetMs>300000)throw Error('PHOTO_RUN_INVALID');for(const i of b.inputs)if(!/^[a-f0-9]{64}$/.test(i.hash)||!Number.isInteger(i.bytes)||i.bytes<1||i.bytes>8388608)throw Error('PHOTO_INPUT_INVALID');id=this.port.id();const r={...b,id,peer,sourceDeviceId:peer.deviceId,group:peer.groupId,createdAt:this.port.now(),updatedAt:this.port.now(),state:'PREPARING',revision:0,inputReady:[],jobs:[],deliveries:[],scale:4,model:(await this.call('contract',{capability:'photo.enhance.v1'})).model};await this.save('photo:'+id,r);return JSON.stringify(r);}throw Error('PHOTO_ROUTE_INVALID');}
  return this.lock('photo:'+id,async()=>{const r=await this.get('photo:'+id);this.owns(peer,r);const index=Number(match[3]);if(match[2]){if(!r.inputs[index])throw Error('PHOTO_INPUT_INVALID');
   if(match[2]==='input'&&m.method==='PUT'){await this.call('validateBytes',{data:m.data,hash:r.inputs[index].hash,bytes:r.inputs[index].bytes});await this.save('photo-input:'+id+':'+index,m.data);r.inputReady=[...new Set([...(r.inputReady??[]),index])];r.updatedAt=this.port.now();await this.save('photo:'+id,r);return '{}';}
   if(match[2]==='capture-result'){const j=r.jobs.find((j:any)=>j.imageIndex===index),g=j&&await this.get('graph:'+j.id);this.owns(peer,g);if(g.state!=='SUCCEEDED')throw Error('PHOTO_RESULT_PENDING');const product=await this.call('product',{descriptor:g.output});await this.save('photo-result:'+id+':'+index,product);return '{"retained":true}';}
   throw Error('PHOTO_ROUTE_INVALID');
  }
  if(m.method==='GET')return JSON.stringify(await this.photoView(r));const b=m.body;if(b.revision!==r.revision)throw Error('PHOTO_RUN_REVISION');
  if(b.jobs){if(b.jobs.length>r.inputs.length||new Set(b.jobs.map((j:any)=>j.imageIndex)).size!==b.jobs.length)throw Error('PHOTO_JOB_SCOPE');for(const j of b.jobs){const g=await this.get('graph:'+j.id);this.owns(peer,g);if(!r.inputs[j.imageIndex]||g.input.ref.contentHash!==r.inputs[j.imageIndex].hash)throw Error('PHOTO_JOB_SCOPE');}r.jobs=b.jobs;}
  if(b.deliveredImage){const i=b.deliveredImage.imageIndex,p=await this.get('photo-result:'+id+':'+i);if(!p||p.hash!==b.deliveredImage.hash)throw Error('PHOTO_RESULT_PENDING');if(!r.deliveries.some((v:any)=>v.imageIndex===i))r.deliveries.push({...b.deliveredImage,receivedAt:this.port.now()});}
  if(b.sourceDurationMs!==undefined&&(!Number.isFinite(b.sourceDurationMs)||b.sourceDurationMs<0))throw Error('PHOTO_DURATION_INVALID');if(b.state==='SUCCEEDED'&&(!(await this.photoView(r)).allCommitted||r.deliveries.length!==r.inputs.length))throw Error('PHOTO_RESULTS_NOT_COMMITTED');if(b.state&&!['RUNNING','SUCCEEDED','FAILED','CANCELLED'].includes(b.state))throw Error('PHOTO_STATE_INVALID');for(const k of ['state','error','sourceDurationMs'])if(b[k]!==undefined)r[k]=b[k];r.revision++;r.updatedAt=this.port.now();await this.save('photo:'+id,r);return JSON.stringify(r);
  });
 }
 private async photoView(r:any){const workflows=[];for(const j of r.jobs){const g=await this.get('graph:'+j.id);if(!g)continue;workflows.push({id:j.id,imageIndex:j.imageIndex,state:g.state,nodes:g.workflow.nodes.map((n:any)=>{const s=g.nodes.find((x:any)=>x.id===n.id);return {...n,state:s.state==='COMMITTED'?'SUCCEEDED':s.executionState??s.state,committed:s.state==='COMMITTED',target:s.target,reason:s.reason??s.waitReason,decision:s.decision,attemptId:s.jobId,retries:s.retries??0,attempts:s.attempts??[]};})});}return {...r,workflows,allCommitted:workflows.length===r.inputs.length&&workflows.every(w=>w.state==='SUCCEEDED'),images:r.inputs.map((_:any,imageIndex:number)=>({imageIndex,delivered:r.deliveries.some((d:any)=>d.imageIndex===imageIndex)}))};}
 private largeView(r:any,devices:any[]){
  const id='large:'+r.id,url=(i:number,k:string)=>'/images/'+encodeURIComponent(id)+'/'+i+'/'+k;
  return {...r,id,peer:undefined,jobs:undefined,kind:'COOPERATIVE',label:'多设备协同 · 原分辨率',inputs:r.inputs.map((i:any,n:number)=>({...i,preview:undefined,url:url(n,'input')})),results:r.results.map((p:any)=>({...p,image:undefined,url:url(p.imageIndex,'result')})),devices:r.deviceIds.map((id:string)=>({id,name:devices.find(d=>d.id===id)?.title??id})),directory:devices.map(d=>({id:d.id,name:d.title})),workflows:r.jobs.filter((j:any)=>j.state!=='SUCCEEDED').slice(0,8).concat(r.jobs.filter((j:any)=>j.state==='SUCCEEDED').slice(-1)).map((j:any)=>({id:j.id,imageIndex:j.imageIndex,state:j.state,nodes:j.nodes??[]})),evidence:'TILED_SDK_RECEIPTS',allCommitted:r.state==='SUCCEEDED'};
 }
 private async largePhoto(peer:any,m:any):Promise<string>{
  const match=/^\/photo-large-runs(?:\/([A-Za-z0-9-]+))?$/.exec(m.route);if(!match)throw Error('PHOTO_ROUTE_INVALID');const b=m.body;
  if(!match[1]){
   if(m.method!=='POST'||!Array.isArray(b?.inputs)||!b.inputs.length||b.inputs.length>8)throw Error('PHOTO_INPUT_INVALID');
   for(const i of b.inputs)if(![i.width,i.height].every((v:any)=>Number.isSafeInteger(v)&&v>0&&v<=32768)||!/^data:image\/jpeg;base64,/.test(i.preview)||i.preview.length>200000)throw Error('PHOTO_INPUT_INVALID');
   const id=this.port.id(),r={id,peer,inputs:b.inputs,createdAt:this.port.now(),updatedAt:this.port.now(),state:'RUNNING',revision:0,results:[],jobs:[],deviceIds:[],scale:4,model:(await this.call('contract',{capability:'photo.enhance.v1'})).model,durationMs:null};await this.save('large-photo:'+id,r);return JSON.stringify({id});
  }
  return this.lock('large-photo:'+match[1],async()=>{
   const r=await this.get('large-photo:'+match[1]);this.owns(peer,r);if(m.method==='GET')return JSON.stringify(r);if(m.method!=='POST')throw Error('PHOTO_ROUTE_INVALID');
   if(b.job){
    const j=b.job,i=r.inputs[j.imageIndex];if(!i||!Number.isInteger(j.tileIndex)||j.tileIndex<0||j.tileIndex>=Math.ceil(i.width/256)*Math.ceil(i.height/256))throw Error('PHOTO_TILE_SCOPE');
    const g=await this.get('graph:'+j.id);this.owns(peer,g);const old=r.jobs.find((v:any)=>v.imageIndex===j.imageIndex&&v.tileIndex===j.tileIndex);if(old&&old.id!==j.id)throw Error('PHOTO_TILE_CONFLICT');
    const row={id:j.id,imageIndex:j.imageIndex,tileIndex:j.tileIndex,state:g.state,nodes:g.workflow.nodes.map((n:any)=>{const v=g.nodes.find((s:any)=>s.id===n.id);return {...n,state:v.state==='COMMITTED'?'SUCCEEDED':v.executionState??v.state,committed:v.state==='COMMITTED',target:v.target};})};
    if(old)Object.assign(old,row);else r.jobs.push(row);
    for(const n of row.nodes)if(n.target&&['SUCCEEDED','RUNNING','ACCEPTED'].includes(n.state)&&!r.deviceIds.includes(n.target.deviceId))r.deviceIds.push(n.target.deviceId);
   }
   if(b.result){
    const p=b.result,i=r.inputs[p.imageIndex];if(!i||p.width!==i.width*4||p.height!==i.height*4||p.previewOnly!==true)throw Error('PHOTO_RESULT_GEOMETRY');
    if(r.jobs.filter((j:any)=>j.imageIndex===p.imageIndex&&j.state==='SUCCEEDED').length!==Math.ceil(i.width/256)*Math.ceil(i.height/256))throw Error('PHOTO_RESULT_PENDING');
    await this.call('validateBytes',{data:p.image,hash:p.hash});if(!r.results.some((v:any)=>v.imageIndex===p.imageIndex))r.results.push(p);
   }
   if(b.state){if(!['SUCCEEDED','FAILED','CANCELLED'].includes(b.state)||!Number.isFinite(b.durationMs)||b.durationMs<0)throw Error('PHOTO_STATE_INVALID');if(b.state==='SUCCEEDED'&&r.results.length!==r.inputs.length)throw Error('PHOTO_RESULTS_NOT_COMMITTED');r.state=b.state;r.durationMs=b.durationMs;r.error=b.error;}
   r.revision++;r.updatedAt=this.port.now();await this.save('large-photo:'+r.id,r);return JSON.stringify({id:r.id});
  });
 }
 async graphs(id:string):Promise<boolean>{return !!await this.get('graph:'+id);}
 async views():Promise<string>{const rows=await this.call('list',{prefix:'photo:'});return JSON.stringify(await Promise.all(rows.map((r:any)=>this.photoView(r))));}
 async record(key:string):Promise<string>{return JSON.stringify(await this.get(key));}
 async display(path:string,bodyJson:string,key:string,address:string,devicesJson:string):Promise<string>{return this.lock('display',async()=>{
  let session=await this.get('display-session');if(!session){session={key:(this.port.id()+this.port.id()).replace(/-/g,'').slice(0,36),generation:0,hiddenBefore:0,seq:0};await this.save('display-session',session);}
  const body=bodyJson?JSON.parse(bodyJson):{},devices=JSON.parse(devicesJson);
  const connection=()=>({invitation:address+'/#display='+session.key,generation:session.generation});
  if(path==='/session')return JSON.stringify(connection());
  if(path==='/reset'){session={key:(this.port.id()+this.port.id()).replace(/-/g,'').slice(0,36),generation:session.generation+1,hiddenBefore:this.port.now(),seq:0};await this.save('display-session',session);return JSON.stringify(connection());}
  if(path==='/connect'||path==='/event'){
   if(key!==session.key)throw Error('DISPLAY_KEY_INVALID');if(path==='/connect')return JSON.stringify({displayOnly:true,nextSeq:session.seq+1});
   const e=body;if(!['PICKING','SELECTED','START','PROGRESS','RESULT','FINISH','FAILED'].includes(e.type)||typeof e.runId!=='string'||e.runId.length>128)throw Error('INVALID_EVENT');if(!Number.isInteger(e.seq)||e.seq<1)throw Error('INVALID_SEQUENCE');if(e.seq<=session.seq)return JSON.stringify({seq:session.seq});
   let r=await this.get('display-current');const now=this.port.now();
   if(e.type==='PICKING'||e.type==='SELECTED'){if(e.type==='SELECTED'&&(!Array.isArray(e.inputs)||e.inputs.length>8||e.inputs.some((i:any)=>!/^data:image\/jpeg;base64,/.test(i.preview)||i.preview.length>200000)))throw Error('INVALID_INPUTS');r={id:'local:'+e.runId,runId:e.runId,kind:'LOCAL',label:'手机本机',state:e.type,createdAt:now,inputs:e.inputs??[],results:[],devices:[{id:'phone',name:'手机 CPU'}],workflows:[],revision:0,evidence:'SOURCE_APP_REPORTED'};}
   else if(!r||r.runId!==e.runId)throw Error('RUN_MISMATCH');
   if(e.type==='START'){r.state='RUNNING';r.createdAt=now;r.results=[];}
   if(e.type==='PROGRESS')Object.assign(r,{phase:e.phase,imageIndex:e.imageIndex,completed:e.completed,total:e.total});
   if(e.type==='RESULT'){if(r.state!=='RUNNING'||!r.inputs[e.imageIndex]||e.product.width!==r.inputs[e.imageIndex].width*4||e.product.height!==r.inputs[e.imageIndex].height*4)throw Error('RESULT_GEOMETRY');await this.call('validateBytes',{data:e.product.image,hash:e.product.hash});if(!r.results.some((p:any)=>p.imageIndex===e.imageIndex))r.results.push({imageIndex:e.imageIndex,...e.product});}
   if(e.type==='FINISH'){if(r.results.length!==r.inputs.length||!Number.isFinite(e.durationMs)||e.durationMs<0)throw Error('INCOMPLETE_RUN');r.state='SUCCEEDED';r.durationMs=e.durationMs;}
   if(e.type==='FAILED'){r.state='FAILED';r.error=e.error;r.durationMs=e.durationMs;}
   r.revision++;r.updatedAt=now;await this.save('display-current',r);if(!['PICKING','SELECTED'].includes(r.state))await this.save('display-run:'+r.runId,r);session.seq=e.seq;await this.save('display-session',session);return JSON.stringify({seq:e.seq});
  }
  const imageUrl=(id:string,i:number,k:string)=>'/images/'+encodeURIComponent(id)+'/'+i+'/'+k;
  const localView=(r:any)=>({...r,inputs:r.inputs.map((i:any,n:number)=>({...i,preview:undefined,originalHash:i.hash,url:imageUrl(r.id,n,'input')})),results:r.results.map((p:any)=>({...p,image:undefined,url:imageUrl(r.id,p.imageIndex,'result')}))});
  const coopView=(r:any)=>{const id='coop:'+r.id,nodes=r.workflows.flatMap((w:any)=>w.nodes),used=r.usedDeviceIds??[...new Set(nodes.filter((n:any)=>n.target&&['SUCCEEDED','ACCEPTED','RUNNING'].includes(n.state)).map((n:any)=>n.target.deviceId))];return {...r,peer:undefined,id,kind:'COOPERATIVE',label:'多设备协同',durationMs:['SUCCEEDED','FAILED','CANCELLED'].includes(r.state)?r.sourceDurationMs:null,inputs:r.inputs.map((i:any,n:number)=>({...i,url:r.inputReady===undefined||r.inputReady.includes(n)?imageUrl(id,n,'input'):null})),results:r.deliveries.map((d:any)=>({...d,url:imageUrl(id,d.imageIndex,'result')})),devices:used.map((id:string)=>({id,name:devices.find((d:any)=>d.id===id)?.title??id})),directory:devices.map((d:any)=>({id:d.id,name:d.title})),evidence:'COORDINATOR_RECEIPTS'};};
  if(path==='/runs'){const local=await this.call('list',{prefix:'display-run:'}),cooperative=await this.call('list',{prefix:'photo:'});const large=await this.call('list',{prefix:'large-photo:'});const runs=[...large.map((r:any)=>this.largeView(r,devices)),...local.filter((r:any)=>!['PICKING','SELECTED'].includes(r.state)).map(localView),...await Promise.all(cooperative.map(async(r:any)=>{let summary=this.summaries.get(r.id);if(!summary||summary.revision!==r.revision||!['SUCCEEDED','FAILED','CANCELLED'].includes(r.state)&&this.port.now()-summary.at>2000){const view=await this.photoView(r);summary={revision:r.revision,at:this.port.now(),devices:[...new Set<string>(view.workflows.flatMap((w:any)=>w.nodes).filter((n:any)=>n.target&&['SUCCEEDED','ACCEPTED','RUNNING'].includes(n.state)).map((n:any)=>n.target.deviceId))]};if(this.summaries.size>100)this.summaries.clear();this.summaries.set(r.id,summary);}return coopView({...r,workflows:[],usedDeviceIds:summary.devices});}))].filter(r=>r.createdAt>=session.hiddenBefore).sort((a,b)=>b.createdAt-a.createdAt);const draft=await this.get('display-current');const preview=draft&&['PICKING','SELECTED'].includes(draft.state)&&draft.createdAt>=session.hiddenBefore&&draft.createdAt>(runs[0]?.createdAt??-1)?localView(draft):null;return JSON.stringify({generation:session.generation,preview,managed:true,coordinator:{connected:true,name:'鸿蒙协调中心'},runs:runs.map(r=>({...r,results:undefined,workflows:undefined}))});}
  if(path.startsWith('/runs/')){const id=decodeURIComponent(path.slice(6));if(id.startsWith('large:')){const r=await this.get('large-photo:'+id.slice(6));if(!r||r.createdAt<session.hiddenBefore)throw Error('RUN_NOT_FOUND');return JSON.stringify(this.largeView(r,devices));}if(id.startsWith('local:')){const stored=await this.get('display-run:'+id.slice(6)),draft=stored?null:await this.get('display-current'),r=stored??(draft?.runId===id.slice(6)?draft:null);if(!r||r.createdAt<session.hiddenBefore)throw Error('RUN_NOT_FOUND');return JSON.stringify(localView(r));}const r=await this.get('photo:'+id.slice(5));if(!r||r.createdAt<session.hiddenBefore)throw Error('RUN_NOT_FOUND');return JSON.stringify(coopView(await this.photoView(r)));}
  const m=/^\/images\/([^/]+)\/(\d+)\/(input|result)$/.exec(path);if(m){const id=decodeURIComponent(m[1]),i=Number(m[2]);if(id.startsWith('large:')){const r=await this.get('large-photo:'+id.slice(6));if(!r||r.createdAt<session.hiddenBefore)throw Error('RUN_NOT_FOUND');const data=m[3]==='input'?r.inputs[i]?.preview.split(',')[1]:r.results.find((v:any)=>v.imageIndex===i)?.image;if(!data)throw Error('IMAGE_NOT_FOUND');return JSON.stringify({data,mime:m[3]==='input'?'image/jpeg':'image/png'});}if(id.startsWith('local:')){const stored=await this.get('display-run:'+id.slice(6)),draft=stored?null:await this.get('display-current'),r=stored??(draft?.runId===id.slice(6)?draft:null);if(!r||r.createdAt<session.hiddenBefore)throw Error('RUN_NOT_FOUND');const data=m[3]==='input'?r.inputs[i]?.preview.split(',')[1]:r.results.find((v:any)=>v.imageIndex===i)?.image;if(!data)throw Error('IMAGE_NOT_FOUND');return JSON.stringify({data,mime:m[3]==='input'?'image/jpeg':'image/png'});}const rid=id.slice(5),r=await this.get('photo:'+rid);if(!r||r.createdAt<session.hiddenBefore||!r.inputs[i])throw Error('RUN_NOT_FOUND');if(m[3]==='result'&&!r.deliveries.some((v:any)=>v.imageIndex===i))throw Error('PHOTO_RESULT_PENDING');const p=await this.get('photo-'+m[3]+':'+rid+':'+i);if(!p)throw Error('IMAGE_NOT_FOUND');return JSON.stringify({data:typeof p==='string'?p:p.image,mime:'image/png'});}
  throw Error('DISPLAY_ROUTE_NOT_FOUND');
 });}
}
