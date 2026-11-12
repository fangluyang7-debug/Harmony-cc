// Bundle the current main planning implementation without changing its algorithms.
// ArkTS calls this pure JS module through a typed JSON boundary; no Node APIs ship.
const fs=require('node:fs'),path=require('node:path'),{buildSync}=require('esbuild');
const root=path.resolve(__dirname,'..'),directory=path.join(root,'apps/harmony/scheduler/src/main/ets/v2/coordinator/generated');
fs.mkdirSync(directory,{recursive:true});
const result=buildSync({stdin:{contents:`
import {plan} from './packages/scheduler-core/src/planning-api';
import {availability} from './packages/scheduler-core/src/availability';
export function planJson(snapshot,request,policy,now,monotonic){
 return JSON.stringify(plan(JSON.parse(snapshot),JSON.parse(request),JSON.parse(policy),{now,monotonic}));
}
export function availabilityJson(profile,executor,priority,version,now){
 return JSON.stringify(availability(JSON.parse(profile),JSON.parse(executor),priority,version,now));
}
`,resolveDir:root,loader:'ts'},bundle:true,platform:'neutral',format:'esm',target:'es2020',write:false,legalComments:'none'});
fs.writeFileSync(path.join(directory,'PlanningCore.js'),result.outputFiles[0].text);
fs.writeFileSync(path.join(directory,'PlanningCore.d.ts'),
 'export declare function planJson(snapshot:string,request:string,policy:string,now:number,monotonic:()=>number):string;\n'+
 'export declare function availabilityJson(profile:string,executor:string,priority:string,version:number,now:number):string;\n');
console.log('Native planning module generated from current scheduler-core sources');
