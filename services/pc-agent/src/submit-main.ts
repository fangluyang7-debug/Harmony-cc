import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {SchedulerSdk} from '@harmony/scheduler-client';
import {nodeSdkPort} from '@harmony/scheduler-client/dist/node';
import {builtinCpuPacks} from '@harmony/reference-capabilities';
async function main(){
 const [configFile,capability,inputFile,outputFile,targetId]=process.argv.slice(2);if(!configFile||!capability||!inputFile||!outputFile)throw Error('SUBMIT_ARGUMENTS');
 const config=JSON.parse(fs.readFileSync(configFile,'utf8')),bytes=fs.readFileSync(inputFile),pack=builtinCpuPacks().find(p=>p.manifest.contract.capability===capability);
 if(!pack)throw Error('CAPABILITY_UNSUPPORTED');if(fs.existsSync(outputFile))throw Error('OUTPUT_ALREADY_EXISTS');
 const sdk=new SchedulerSdk(nodeSdkPort(config.connection)),input=await sdk.registerInput(bytes,pack.manifest.contract.inputSchemas[0]),id=randomUUID();
 const task=await sdk.submit({version:3,id,outputContract:pack.manifest.contract.outputSchemas[0],qualityTarget:'reference',nodes:[{id:'compute',capability,input,parameters:'{}',dependsOn:[],...(targetId?{targetId}:{})}]},{requestId:id,budgetMs:30000,resultDestination:'ORIGIN'});
 console.log('Job submitted: '+task.id);const result=await task.result();fs.writeFileSync(outputFile,result.output,{flag:'wx'});console.log('Completed; output saved.');
}
void main().catch(error=>{console.error(error instanceof Error&&/^[A-Z_:]+$/.test(error.message)?error.message:'SUBMISSION_FAILED');process.exitCode=1;});
