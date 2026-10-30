import fs from 'node:fs';
import path from 'node:path';
import { createCoordinator } from './app';
import { loadConfig } from './config';
import { protocolId, validResourceVectorV2 } from '@harmony/scheduler-core';

/** Offline administrator command; the normal coordinator lock excludes a running service. */
async function main(){
  const [specification,output]=process.argv.slice(2);
  if(!specification||!output||!path.isAbsolute(output))throw Error('PROVISION_ARGUMENTS');
  const input=JSON.parse(fs.readFileSync(specification,'utf8'));
  if(!input||Object.keys(input).sort().join('|')!=='address|capacity|deviceId|groupId|holderInstanceId|principalId')throw Error('PROVISION_INVALID');
  const address=new URL(input.address);
  if(![input.deviceId,input.groupId,input.holderInstanceId,input.principalId].every(protocolId)||!validResourceVectorV2(input.capacity)||!input.capacity.length||
    address.protocol!=='https:'||address.pathname!=='/'||address.username||address.password||address.search||address.hash)throw Error('PROVISION_INVALID');
  const runtime=await createCoordinator(loadConfig(process.env));
  let fd:number|undefined;
  try{
    if(await runtime.db.device.findUnique({where:{id:JSON.stringify(['budget',input.deviceId])}}))throw Error('DEVICE_ALREADY_PROVISIONED');
    fd=fs.openSync(output,'wx',0o600);
    await runtime.allotments.confirmDevice(input.deviceId,input.capacity,[{groupId:input.groupId,holderInstanceId:input.holderInstanceId,appInstanceId:null}]);
    const invitation=await runtime.auth.invite(input.groupId,input.principalId,input.deviceId,input.address);
    fs.writeFileSync(fd,JSON.stringify({invitation,holderInstanceId:input.holderInstanceId,domain:loadConfig(process.env).domain},null,2));fs.fsyncSync(fd);
    console.log('Device budget confirmed; private invitation written to the requested file.');
  }finally{if(fd!==undefined)fs.closeSync(fd);await runtime.close();}
}
void main().catch(()=>{console.error('PROVISION_FAILED: check configuration, existing output and coordinator lock; no credentials logged.');process.exitCode=1;});
