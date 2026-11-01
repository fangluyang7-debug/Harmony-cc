import fs from 'node:fs';
import path from 'node:path';
import {appRequest} from '@harmony/scheduler-client/dist/node';
/** Running this owner-side command is explicit approval of the supplied registration policy. */
async function main(){
 const [ownerFile,policyFile,destination]=process.argv.slice(2);
 if(!ownerFile||!policyFile||!destination)throw Error('APP_REGISTER_ARGUMENTS');
 const owner=JSON.parse(fs.readFileSync(ownerFile,'utf8')),policy=JSON.parse(fs.readFileSync(policyFile,'utf8'));
 if(fs.existsSync(destination))throw Error('APP_CONFIG_ALREADY_EXISTS');
 const request=appRequest(owner.connection),invitation=JSON.parse(await request('/v2/apps/registrations',JSON.stringify(policy))),registration=JSON.parse(await request('/v2/apps/exchange',JSON.stringify({registrationId:invitation.registrationId,code:invitation.code})));
 const connection={...owner.connection,credential:registration.credential};
 fs.mkdirSync(path.dirname(path.resolve(destination)),{recursive:true});fs.writeFileSync(destination,JSON.stringify({connection,identity:registration.peer,offlineBase:registration.offlineBase,onlineExtra:registration.onlineExtra,quota:registration.quota},null,2),{flag:'wx',mode:0o600});
 console.log('App registered; independent configuration saved.');
}
void main().catch(error=>{console.error(error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'APP_REGISTRATION_FAILED');process.exitCode=1;});
