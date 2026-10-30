import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, X509Certificate, createPrivateKey, createPublicKey, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isIP, createServer } from 'node:net';
import { CoordinatorConfig } from './config';

export interface Identity { id:string; domain:string; certificateHost:string; key:string; cert:string; }
/** One file commits key + certificate + identity together. No secrets are logged. */
export function loadIdentity(config:CoordinatorConfig):Identity {
  fs.mkdirSync(config.dataDir,{recursive:true});
  const destination=path.join(config.dataDir,'identity.json');
  if(fs.existsSync(destination)){
    const value=JSON.parse(fs.readFileSync(destination,'utf8')) as Identity;
    if(value.domain!==config.domain||value.certificateHost!==config.certificateHost||typeof value.id!=='string')throw new Error('COORDINATOR_IDENTITY_CONFIG_MISMATCH');
    const certificate=new X509Certificate(value.cert);
    if(!certificate.publicKey.equals(createPublicKey(createPrivateKey(value.key))))throw new Error('COORDINATOR_IDENTITY_CORRUPT');
    return value;
  }
  const staging=fs.mkdtempSync(path.join(config.dataDir,'identity-staging-'));
  const keyPath=path.join(staging,'key.pem'),certPath=path.join(staging,'cert.pem');
  try {
    const san=(isIP(config.certificateHost)?'IP:':'DNS:')+config.certificateHost;
    execFileSync(config.openssl,['req','-x509','-newkey','rsa:3072','-sha256','-nodes','-days','365','-subj','/CN='+config.certificateHost,'-addext','subjectAltName='+san,'-keyout',keyPath,'-out',certPath],{stdio:'ignore',windowsHide:true});
    const identity={id:randomUUID(),domain:config.domain,certificateHost:config.certificateHost,key:fs.readFileSync(keyPath,'utf8'),cert:fs.readFileSync(certPath,'utf8')};
    const temporary=path.join(staging,'identity.json'),fd=fs.openSync(temporary,'wx',0o600);
    try{fs.writeFileSync(fd,JSON.stringify(identity));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temporary,destination);
    return identity;
  }finally{
    for(const file of [keyPath,certPath])if(fs.existsSync(file))fs.unlinkSync(file);
    if(fs.existsSync(path.join(staging,'identity.json')))fs.unlinkSync(path.join(staging,'identity.json'));
    fs.rmdirSync(staging);
  }
}

/** OS-owned lock releases on crash. Windows named pipes avoid collisions with ephemeral TCP ports. */
export async function acquireProcessLock(dataDir:string):Promise<()=>Promise<void>> {
  fs.mkdirSync(dataDir,{recursive:true});
  const canonical=fs.realpathSync(dataDir),key=process.platform==='win32'?canonical.toLowerCase():canonical;
  const port=30000+createHash('sha256').update(key).digest().readUInt32BE(0)%30000;
  const server=createServer(socket=>socket.destroy());
  await new Promise<void>((resolve,reject)=>{
    server.once('error',()=>reject(new Error('COORDINATOR_LOCK_UNAVAILABLE')));
    const endpoint=process.platform==='win32'?{path:'\\\\.\\pipe\\harmony-coordinator-'+createHash('sha256').update(key).digest('hex'),exclusive:true}:{host:'127.0.0.1',port,exclusive:true};
    server.listen(endpoint,()=>resolve());
  });
  return ()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
