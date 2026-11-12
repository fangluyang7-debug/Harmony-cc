function protocolId(v:string):boolean{return typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);}
export interface DeclaredNode {id:string;capability:string;contractId?:string;dependsOn:string[];parameters?:string;effects?:'PURE'|'COMMIT';privacy?:'LOCAL_ONLY'|'OWNER_SERVICE'|'SHARED';}
export interface DeclaredWorkflow {id:string;capabilities:string[];inputSchema?:string;outputContract?:string;nodes?:DeclaredNode[];qualityTarget?:string;alternatives?:DeclaredWorkflow[];}
export interface AppDeclaration {version:1;revision:string;workflows:DeclaredWorkflow[];}
function validWorkflow(w:DeclaredWorkflow,contracts:string[]):boolean {
 if(!w||!Object.keys(w).every(k=>['id','capabilities','inputSchema','outputContract','nodes','qualityTarget','alternatives'].includes(k))||!protocolId(w.id)||!Array.isArray(w.capabilities)||!w.capabilities.length||w.capabilities.length>32||!w.capabilities.every(protocolId))return false;
 if(w.qualityTarget!==undefined&&!protocolId(w.qualityTarget))return false;
 if(w.alternatives!==undefined){
  if(w.nodes!==undefined||!w.qualityTarget||!protocolId(w.inputSchema!)||!protocolId(w.outputContract!)||!Array.isArray(w.alternatives)||w.alternatives.length<1||w.alternatives.length>8)return false;
  if(new Set(w.alternatives.map(a=>a?.id)).size!==w.alternatives.length)return false;
  return w.alternatives.every(a=>a&&a.alternatives===undefined&&a.nodes!==undefined&&a.inputSchema===w.inputSchema&&a.outputContract===w.outputContract&&a.qualityTarget===w.qualityTarget&&validWorkflow(a,w.capabilities))&&w.capabilities.every(c=>w.alternatives!.some(a=>a.capabilities.includes(c)));
 }
 if(w.nodes===undefined)return w.inputSchema===undefined&&w.outputContract===undefined&&w.capabilities.every(c=>contracts.includes(c));
 if(typeof w.inputSchema!=='string'||typeof w.outputContract!=='string'||!protocolId(w.inputSchema)||!protocolId(w.outputContract)||!Array.isArray(w.nodes)||!w.nodes.length||w.nodes.length>32)return false;
 const seen=new Set<string>();
 for(const n of w.nodes){if(!n||!Object.keys(n).every(k=>['id','capability','contractId','dependsOn','parameters','effects','privacy'].includes(k))||!protocolId(n.id)||seen.has(n.id)||!w.capabilities.includes(n.capability)||!contracts.includes(n.contractId??n.capability)||!Array.isArray(n.dependsOn)||!n.dependsOn.every(id=>seen.has(id))||new Set(n.dependsOn).size!==n.dependsOn.length)return false;if(n.effects!==undefined&&!['PURE','COMMIT'].includes(n.effects))return false;if(n.privacy!==undefined&&!['LOCAL_ONLY','OWNER_SERVICE','SHARED'].includes(n.privacy))return false;if(n.effects==='COMMIT'&&!w.qualityTarget)return false;if(n.parameters!==undefined){if(typeof n.parameters!=='string'||n.parameters.length>65536)return false;try{const p=JSON.parse(n.parameters) as Object;if(!p||typeof p!=='object'||Array.isArray(p))return false;}catch{return false;}}seen.add(n.id);}
 return w.capabilities.every(c=>w.nodes!.some(n=>n.capability===c));
}
export function validDeclaration(value:Object,contracts:string[]):boolean {
  const v=value as AppDeclaration;
  return !!v&&v.version===1&&Object.keys(v).every(k=>['version','revision','workflows'].includes(k))&&protocolId(v.revision)&&
    Array.isArray(v.workflows)&&v.workflows.length>0&&v.workflows.length<=32&&new Set(v.workflows.map(w=>w?.id)).size===v.workflows.length&&
    v.workflows.every(w=>validWorkflow(w,contracts));
}
