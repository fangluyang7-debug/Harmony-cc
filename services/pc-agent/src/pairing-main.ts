import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { protocolId } from '@harmony/scheduler-core';
import { DurableLedger } from './durable-ledger';

async function main(){
  const [invitationFile,directory]=process.argv.slice(2);
  if(!invitationFile||!directory||!path.isAbsolute(directory))throw Error('PAIR_ARGUMENTS');
  const input=JSON.parse(fs.readFileSync(invitationFile,'utf8')),invite=input.invitation;
  if(!invite||!protocolId(input.holderInstanceId)||!['REAL','SIMULATED'].includes(input.domain)||invite.version!==2||
    !protocolId(invite.inviteId)||!protocolId(invite.groupId)||typeof invite.code!=='string'||!/^[A-Za-z0-9_-]{24}$/.test(invite.code)||
    !Number.isSafeInteger(invite.expiresAt)||invite.expiresAt<=Date.now())throw Error('INVITATION_INVALID');
  const address=new URL(invite.address),fingerprint=new X509Certificate(invite.certificate).fingerprint256.replaceAll(':','').toLowerCase();
  if(address.protocol!=='https:'||address.pathname!=='/'||address.username||address.password||address.search||address.hash||fingerprint!==invite.fingerprint)throw Error('INVITATION_TRUST_INVALID');
  const request=(route:string,body?:unknown)=>new Promise<any>((resolve,reject)=>{
    const bytes=body?Buffer.from(JSON.stringify(body)):null;
    const req=https.request(new URL(route,address),{method:bytes?'POST':'GET',ca:invite.certificate,rejectUnauthorized:true,
      checkServerIdentity:(host,cert)=>tls.checkServerIdentity(host,cert)||(cert.fingerprint256?.replaceAll(':','').toLowerCase()===fingerprint?undefined:Error('PIN_MISMATCH')),
      headers:bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{}},res=>{
      const chunks:Buffer[]=[];let size=0;res.on('data',(b:Buffer)=>{size+=b.length;if(size>16384)req.destroy(Error('PAIR_RESPONSE_LIMIT'));else chunks.push(b);});
      res.on('error',reject);res.on('end',()=>{try{if(res.statusCode!==200&&res.statusCode!==201)throw Error('PAIR_REJECTED');resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(e){reject(e);}});
    });
    const timeout=setTimeout(()=>req.destroy(Error('PAIR_TIMEOUT')),10000);req.once('close',()=>clearTimeout(timeout));req.on('error',reject);req.end(bytes??undefined);
  });
  const identity=await request('/v2/identity');if(identity.version!==2||identity.domain!==input.domain)throw Error('PAIR_DOMAIN_INVALID');
  // A one-shot directory and marker prevent silently retrying an uncertain exchange or replacing an old ledger.
  fs.mkdirSync(directory,{mode:0o700});
  fs.writeFileSync(path.join(directory,'pairing.pending'),'Reconcile this registration if no agent.json exists.\n',{flag:'wx',mode:0o600});
  const paired=await request('/v2/pair',{inviteId:invite.inviteId,code:invite.code,holderInstanceId:input.holderInstanceId});
  if(typeof paired.credential!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(paired.credential)||paired.peer?.groupId!==invite.groupId||paired.peer?.holderInstanceId!==input.holderInstanceId||
    !protocolId(paired.peer.deviceId)||!protocolId(paired.peer.principalId)||!protocolId(paired.peer.credentialId))throw Error('PAIR_RESPONSE_INVALID');
  const binding={groupId:paired.peer.groupId,deviceId:paired.peer.deviceId,holderInstanceId:input.holderInstanceId,appInstanceId:null};
  const config={directory:path.join(directory,'ledger'),identity:binding,connection:{address:address.origin+'/',certificate:invite.certificate,fingerprint,credential:paired.credential,domain:input.domain}};
  const temporary=path.join(directory,'agent.pending.json'),fd=fs.openSync(temporary,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(config,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temporary,path.join(directory,'agent.json'));
  const ledger=await DurableLedger.open(config.directory,binding,invite.certificate);await ledger.close();
  fs.unlinkSync(path.join(directory,'pairing.pending'));
  console.log('Pairing completed; private agent configuration and ledger initialized.');
}
void main().catch(()=>{console.error('PAIRING_FAILED: retain any registration files for reconciliation; no credentials logged.');process.exitCode=1;});
