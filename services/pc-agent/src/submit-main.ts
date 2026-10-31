import { submitWhenAvailable } from './submit-wait';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { digest } from '@harmony/reference-capabilities';
import { transfer } from '@harmony/resource-transport';
import { allotmentTransport } from './allotment-client';
async function main(){
  const [configFile,capability,inputFile,outputFile,targetId]=process.argv.slice(2);if(!configFile||!capability||!inputFile||!outputFile)throw Error('SUBMIT_ARGUMENTS');
  const config=JSON.parse(fs.readFileSync(configFile,'utf8')),input=fs.readFileSync(inputFile),request=allotmentTransport(config.connection);
  if(fs.existsSync(outputFile))throw Error('OUTPUT_ALREADY_EXISTS');
  const plan=await submitWhenAvailable(request,{requestId:randomUUID(),capability,contentHash:digest(input),bytes:input.length,...(targetId?{targetId}:{})},()=>console.error('WAITING_FOR_CAPACITY: task not submitted; waiting up to 15 seconds.')) as any;
  console.log('Selected device: '+plan.deviceId+'; job: '+plan.jobId);
  await transfer(config.connection,plan.inputTicket,config.connection.credential,input);
  await request('/v2/jobs/'+plan.jobId+'/start',{});
  const deadline=Date.now()+60000;
  while(Date.now()<deadline){
    const result=await request('/v2/jobs/'+plan.jobId,null) as any;
    if(result.outputTicket){const output=await transfer(config.connection,result.outputTicket,config.connection.credential);fs.writeFileSync(outputFile,output.bytes,{flag:'wx'});console.log('Completed; output saved.');return;}
    if(['FAILED','REJECTED','CANCELLED_SETTLED','SIDE_EFFECT_UNKNOWN','HOLDER_RECORD_MISSING'].includes(result.state))throw Error('JOB_'+result.state);
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw Error('RESULT_WAIT_TIMEOUT');
}
void main().catch(error=>{console.error(error instanceof Error&&/^[A-Z_:]+$/.test(error.message)?error.message:'SUBMISSION_FAILED');process.exitCode=1;});
