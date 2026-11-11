const fs=require('node:fs'),path=require('node:path');
class PhotoDisplayRecords{
 constructor(directory){this.directory=directory;this.records=new Map();if(directory){fs.mkdirSync(directory,{recursive:true});for(const file of fs.readdirSync(directory).filter(f=>/^run-[a-f0-9-]{36}\.json$/.test(f))){const record=JSON.parse(fs.readFileSync(path.join(directory,file)));this.records.set(record.runId,record);}}}
 save(state){if(!state.runId||!['SUCCEEDED','FAILED'].includes(state.status))return;this.records.set(state.runId,structuredClone(state));if(this.directory&&/^[a-f0-9-]{36}$/.test(state.runId)){const target=path.join(this.directory,'run-'+state.runId+'.json');fs.writeFileSync(target+'.tmp',JSON.stringify(state));fs.renameSync(target+'.tmp',target);}}
 list(){return [...this.records.values()];}
 get(id){return this.records.get(id);}
}
const imageUrl=(id,index,kind)=>'/images/'+encodeURIComponent(id)+'/'+index+'/'+kind;
function nativeRun(s){
 const id='local:'+s.runId,terminal=['SUCCEEDED','FAILED'].includes(s.status);
 return {id,kind:'LOCAL',label:'手机本机',state:s.status,revision:s.revision,createdAt:s.startedAt??s.receivedAt,updatedAt:s.receivedAt,durationMs:terminal?s.durationMs:null,budgetMs:s.budgetMs??null,model:s.model??null,scale:s.scale??4,metadataSource:s.metadataSource??'NOT_REPORTED',inputs:s.inputs.map((i,index)=>({...i,preview:undefined,originalHash:i.hash,url:imageUrl(id,index,'input')})),results:s.results.map(r=>({...r,image:undefined,url:imageUrl(id,r.imageIndex,'result')})),phase:s.phase??'',imageIndex:s.imageIndex??0,completed:s.completed,total:s.total,devices:[{id:'phone-local',name:'手机 CPU'}],workflows:[],evidence:'SOURCE_APP_REPORTED',error:s.error??null};
}
function cooperativeRun(r,devices=[]){
 const id='coop:'+r.id,nodes=r.workflows?.flatMap(w=>w.nodes)??[],used=[...new Set(nodes.filter(n=>n.target&&(n.committed||['RUNNING','ACCEPTED','SUCCEEDED'].includes(n.state))).map(n=>n.target.deviceId))];
 return {id,kind:r.mode==='LOCAL'?'COORDINATED_LOCAL':r.mode==='LOCAL_PROCESS_TEST'?'SIMULATED':'COOPERATIVE',label:r.mode==='LOCAL'?'协调器内单机':r.mode==='LOCAL_PROCESS_TEST'?'本机进程验证':'多设备协同',state:r.state,revision:r.revision,createdAt:r.createdAt,updatedAt:r.updatedAt,durationMs:['SUCCEEDED','FAILED','CANCELLED'].includes(r.state)?r.sourceDurationMs:null,budgetMs:r.budgetMs,model:r.model,scale:r.scale,metadataSource:'COORDINATOR',inputs:r.inputs.map((i,index)=>({...i,url:r.images?.find(v=>v.imageIndex===index)?.inputAvailable?imageUrl(id,index,'input'):null})),results:(r.images??[]).filter(i=>i.delivered).map(i=>({...i,hash:r.deliveries?.find(d=>d.imageIndex===i.imageIndex)?.hash,url:imageUrl(id,i.imageIndex,'result')})),devices:used.map(id=>({id,name:devices.find(d=>d.id===id)?.name??id})),directory:devices,workflows:r.workflows??[],evidence:'COORDINATOR_RECEIPTS',error:r.error};
}
function summary(r){const {workflows,directory,results,...rest}=r;return {...rest,inputs:r.inputs.map(({url,...i})=>i),resultCount:results.length,devices:r.devices};}
module.exports={PhotoDisplayRecords,nativeRun,cooperativeRun,summary};
