import {canonical} from '@harmony/scheduler-core';

export interface Invariant<I,O> {id:string;version:number;precondition?:(input:I)=>boolean;check:(input:I,output:O)=>boolean;}
export function frozenPack<I,O>(reference:(input:I)=>O){
  return (input:I,output:O)=>canonical(reference(input))===canonical(output)?1:0;
}
export function tolerancePack<I,O>(metric:(input:I,output:O)=>number){
  return (input:I,output:O)=>{const score=metric(input,output);return Number.isFinite(score)&&score>=0&&score<=1?score:0;};
}
export function propertyPack<I,O>(invariants:Invariant<I,O>[]){
  if(!invariants.length||new Set(invariants.map(i=>i.id)).size!==invariants.length||invariants.some(i=>!i.id||!Number.isSafeInteger(i.version)||i.version<1))throw Error('INVARIANT_INVALID');
  return (input:I,output:O)=>{const applicable=invariants.filter(i=>!i.precondition||i.precondition(input));return applicable.length&&applicable.every(i=>i.check(input,output))?1:0;};
}
