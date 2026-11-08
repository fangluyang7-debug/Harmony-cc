import {protocolId} from '@harmony/scheduler-core';
interface DeclaredNode {id:string;capability:string;dependsOn:string[];}
interface DeclaredWorkflow {id:string;capabilities:string[];inputSchema?:string;outputContract?:string;nodes?:DeclaredNode[];}
export interface AppDeclaration {version:1;revision:string;workflows:DeclaredWorkflow[];}
function validWorkflow(w:DeclaredWorkflow,contracts:string[]):boolean {
 if(!w||!Object.keys(w).every(k=>['id','capabilities','inputSchema','outputContract','nodes'].includes(k))||!protocolId(w.id)||!Array.isArray(w.capabilities)||!w.capabilities.length||w.capabilities.length>32||!w.capabilities.every(c=>contracts.includes(c)))return false;
 if(w.nodes===undefined)return w.inputSchema===undefined&&w.outputContract===undefined;
 if(typeof w.inputSchema!=='string'||typeof w.outputContract!=='string'||!protocolId(w.inputSchema)||!protocolId(w.outputContract)||!Array.isArray(w.nodes)||!w.nodes.length||w.nodes.length>32)return false;
 const seen=new Set<string>();
 for(const n of w.nodes){if(!n||!Object.keys(n).every(k=>['id','capability','dependsOn'].includes(k))||!protocolId(n.id)||seen.has(n.id)||!w.capabilities.includes(n.capability)||!Array.isArray(n.dependsOn)||!n.dependsOn.every(id=>seen.has(id))||new Set(n.dependsOn).size!==n.dependsOn.length)return false;seen.add(n.id);}
 return w.capabilities.every(c=>w.nodes!.some(n=>n.capability===c));
}
export function validDeclaration(value:unknown,contracts:string[]):value is AppDeclaration {
  const v=value as AppDeclaration;
  return !!v&&v.version===1&&Object.keys(v).every(k=>['version','revision','workflows'].includes(k))&&protocolId(v.revision)&&
    Array.isArray(v.workflows)&&v.workflows.length>0&&v.workflows.length<=32&&new Set(v.workflows.map(w=>w?.id)).size===v.workflows.length&&
    v.workflows.every(w=>validWorkflow(w,contracts));
}
