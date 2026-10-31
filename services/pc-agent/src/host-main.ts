import fs from 'node:fs';
import { CpuHost, CpuHostConfig } from './host';
async function main(){
  const [pairedFile,contributionFile]=process.argv.slice(2);if(!pairedFile||!contributionFile)throw Error('HOST_ARGUMENTS');
  const config={...JSON.parse(fs.readFileSync(pairedFile,'utf8')),contribution:JSON.parse(fs.readFileSync(contributionFile,'utf8'))} as CpuHostConfig;
  const host=await CpuHost.open(config,error=>console.error(error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'CPU_HOST_OPERATION_FAILED'));
  let stopping=false;const close=async()=>{if(stopping)return;stopping=true;await host.close();};
  process.once('SIGINT',()=>{void close();});process.once('SIGTERM',()=>{void close();});
  process.on('message',message=>{if(message==='stop')void close().then(()=>process.disconnect?.());});
  host.start();console.log('CPU host started: automatic profiles, calibration and execution enabled.');
}
void main().catch(()=>{console.error('CPU_HOST_START_FAILED: check paired configuration and contribution policy.');process.exitCode=1;});
