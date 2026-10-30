import fs from 'node:fs';
import path from 'node:path';
import { DurableLedger } from './durable-ledger';
import { RecoveryClient, RecoveryConnection } from './recovery-client';

async function main(){
  const filename=process.argv[2];if(!filename)throw Error('CONFIG_PATH_REQUIRED');
  const config=JSON.parse(fs.readFileSync(filename,'utf8')) as {directory:string;identity:{groupId:string;deviceId:string;holderInstanceId:string;appInstanceId:string|null};connection:RecoveryConnection};
  if(!config||typeof config.directory!=='string'||!path.isAbsolute(config.directory)||!config.identity||!config.connection)throw Error('CONFIG_INVALID');
  // A recovery invocation must never create a replacement empty ledger after a path typo.
  if(!fs.existsSync(path.join(config.directory,'ledger.initialized')))throw Error('EXISTING_LEDGER_REQUIRED');
  const ledger=await DurableLedger.open(config.directory,config.identity,config.connection.certificate);
  const client=new RecoveryClient(ledger,config.connection,()=>process.stderr.write('Recovery connection interrupted; state retained.\n'));
  let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;await client.close();await ledger.close();};
  process.once('SIGINT',()=>{void stop();});process.once('SIGTERM',()=>{void stop();});
  client.start();process.stdout.write('Recovery client started; execution disabled.\n');
}
void main().catch(()=>{process.stderr.write('Recovery client failed; verify configuration and ledger.\n');process.exitCode=1;});
