import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createPrivateKey,createPublicKey,sign,X509Certificate} from 'node:crypto';
import {isIP,createConnection} from 'node:net';
import {canonical} from '@harmony/scheduler-core';
import {DataEndpointIdentity,ArtifactSchema,validDataEndpoint,transferDigest} from '@harmony/resource-transport';
import {RecoveryConnection} from './recovery-client';
import {allotmentTransport} from './allotment-client';
import {createSignedDataEndpoint} from './signed-data-endpoint';

export interface DataHostConfig {listenHost:string;advertisedHost:string;port?:number;openssl?:string;}
function opensslExecutable(explicit?:string){
  if(explicit||process.env.PC_AGENT_OPENSSL||process.env.COORDINATOR_OPENSSL)return explicit??process.env.PC_AGENT_OPENSSL??process.env.COORDINATOR_OPENSSL!;
  if(process.platform==='win32')for(const directory of (process.env.PATH??'').split(path.delimiter).filter(Boolean)){
    const direct=path.join(directory,'openssl.exe');if(fs.existsSync(direct))return direct;
    // Git for Windows normally exposes cmd/git.exe, not usr/bin/openssl.exe, on PATH.
    if(fs.existsSync(path.join(directory,'git.exe'))){const bundled=path.resolve(directory,'..','usr','bin','openssl.exe');if(fs.existsSync(bundled))return bundled;}
  }
  return 'openssl';
}
/** Let the OS route to the paired coordinator, then advertise that interface; reachability still requires a peer probe. */
export function discoverDataHost(connection:RecoveryConnection):Promise<DataHostConfig>{
  const address=new URL(connection.address);
  return new Promise((resolve,reject)=>{
    const socket=createConnection({host:address.hostname.replace(/^\[|\]$/g,''),port:Number(address.port||443)});
    socket.setTimeout(3000,()=>socket.destroy(Error('DATA_ROUTE_TIMEOUT')));socket.once('error',reject);
    socket.once('connect',()=>{const host=socket.localAddress?.replace(/^::ffff:/,'');socket.destroy();if(!host||!isIP(host)){reject(Error('DATA_ROUTE_UNKNOWN'));return;}resolve({listenHost:host,advertisedHost:host});});
  });
}
/** Each installation owns its key. Registration creates a fresh endpoint epoch on every process start. */
export async function openDataHost(directory:string,connection:RecoveryConnection,options:DataHostConfig,schemas:ReadonlyMap<string,ArtifactSchema>){
  if(!options||!isIP(options.listenHost)||!/^([A-Za-z0-9.-]+|[A-Fa-f0-9:]+)$/.test(options.advertisedHost)||
    options.port!==undefined&&(!Number.isSafeInteger(options.port)||options.port<0||options.port>65535))throw Error('DATA_HOST_CONFIG_INVALID');
  const storage=path.join(directory,'data-endpoint',transferDigest(options.advertisedHost));fs.mkdirSync(storage,{recursive:true});
  const identityFile=path.join(storage,'identity.json');let identity:{host:string;key:string;certificate:string};
  if(fs.existsSync(identityFile))identity=JSON.parse(fs.readFileSync(identityFile,'utf8'));
  else{
    const staging=fs.mkdtempSync(path.join(storage,'key-')),keyFile=path.join(staging,'key.pem'),certificateFile=path.join(staging,'cert.pem');
    try{
      execFileSync(opensslExecutable(options.openssl),['req','-x509','-newkey','rsa:3072','-sha256','-nodes','-days','365','-subj','/CN='+options.advertisedHost,
        '-addext','subjectAltName='+(isIP(options.advertisedHost)?'IP:':'DNS:')+options.advertisedHost,'-keyout',keyFile,'-out',certificateFile],{stdio:'ignore',windowsHide:true});
      identity={host:options.advertisedHost,key:fs.readFileSync(keyFile,'utf8'),certificate:fs.readFileSync(certificateFile,'utf8')};
      const temporary=path.join(staging,'identity.json'),fd=fs.openSync(temporary,'wx',0o600);
      try{fs.writeFileSync(fd,JSON.stringify(identity));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,identityFile);
    }finally{for(const file of [keyFile,certificateFile])if(fs.existsSync(file))fs.unlinkSync(file);if(fs.readdirSync(staging).length===0)fs.rmdirSync(staging);}
  }
  if(identity.host!==options.advertisedHost||!new X509Certificate(identity.certificate).publicKey.equals(createPublicKey(createPrivateKey(identity.key))))throw Error('DATA_HOST_IDENTITY_MISMATCH');
  const request=allotmentTransport(connection);let endpoint:DataEndpointIdentity|null=null;
  const data=createSignedDataEndpoint({directory:path.join(storage,'cache'),domain:connection.domain,key:identity.key,certificate:identity.certificate,
    coordinatorCertificate:connection.certificate,endpoint:()=>endpoint,schemas,
    consume:(signed,proof)=>request('/v2/data/consume',{signed,proof}),receipt:(authorizationId,contentHash,bytes)=>request('/v2/data/receipts',{authorizationId,contentHash,bytes})});
  try{
    await new Promise<void>((resolve,reject)=>{data.server.once('error',reject);data.server.listen(options.port??0,options.listenHost,()=>resolve());});
    const address=data.server.address();if(!address||typeof address==='string')throw Error('DATA_HOST_ADDRESS_INVALID');
    const host=isIP(options.advertisedHost)===6?'['+options.advertisedHost+']':options.advertisedHost;
    const proposal={address:'https://'+host+':'+address.port,certificate:identity.certificate};
    const register=async()=>{
      endpoint=null;
      const challenge=await request('/v2/data/endpoints/challenge',proposal) as {endpoint:DataEndpointIdentity};
      if(!validDataEndpoint(challenge.endpoint)||challenge.endpoint.certificate!==identity.certificate||challenge.endpoint.address!==proposal.address)throw Error('DATA_HOST_REGISTRATION_INVALID');
      const signature=sign('sha256',Buffer.from(canonical(challenge)),identity.key).toString('base64');
      const registered=await request('/v2/data/endpoints/register',{challenge,signature}) as DataEndpointIdentity;
      if(canonical(registered)!==canonical(challenge.endpoint))throw Error('DATA_HOST_REGISTRATION_INVALID');endpoint=registered;
    };
    await register();
    return {...data,identity:()=>endpoint,register,close:async()=>{endpoint=null;data.server.closeAllConnections();await new Promise<void>(resolve=>data.server.close(()=>resolve()));}};
  }catch(error){data.server.closeAllConnections();await new Promise<void>(resolve=>data.server.close(()=>resolve()));throw error;}
}
