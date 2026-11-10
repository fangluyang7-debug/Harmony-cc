import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createPrivateKey,createPublicKey,sign,X509Certificate} from 'node:crypto';
import {isIP,createConnection} from 'node:net';
import {canonical} from '@harmony/scheduler-core';
import {ArtifactChannel,DataEndpointIdentity,ArtifactSchema,validDataEndpoint,transferDigest} from '@harmony/resource-transport';
import {RecoveryConnection} from './recovery-client';
import {allotmentTransport} from './allotment-client';
import {createSignedDataEndpoint} from './signed-data-endpoint';
import {pcTraceClockDomainId} from './execution-trace';

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
export function validateDataHostConfig(options:DataHostConfig):void {
  if(!options||typeof options.listenHost!=='string'||!isIP(options.listenHost)||typeof options.advertisedHost!=='string'||!/^([A-Za-z0-9.-]+|[A-Fa-f0-9:]+)$/.test(options.advertisedHost)||
    options.port!==undefined&&(!Number.isSafeInteger(options.port)||options.port<0||options.port>65535))throw Error('DATA_HOST_CONFIG_INVALID');
}
/** Each installation owns its key. Registration creates a fresh endpoint epoch on every process start. */
export async function openDataHost(directory:string,connection:RecoveryConnection,options:DataHostConfig,schemas:ReadonlyMap<string,ArtifactSchema>){
  validateDataHostConfig(options);
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
  const data=createSignedDataEndpoint({directory:path.join(directory,'data-endpoint','cache'),domain:connection.domain,key:identity.key,certificate:identity.certificate,
    coordinatorCertificate:connection.certificate,endpoint:()=>endpoint,schemas,
    onRejected:(authorizationId,code)=>request('/v2/data/rejections',{authorizationId,code}),
    onMissing:authorizationId=>request('/v2/data/missing',{authorizationId}),
    onReceived:async(signed,startMono,endMono)=>{if(signed.authorization.version===2)await request('/v2/data/traces',{authorizationId:signed.authorization.id,side:'RECEIVER',interval:{clockDomainId:pcTraceClockDomainId,startMono,endMono}});},
    consume:(signed,proof)=>request('/v2/data/consume',{signed,proof}),receipt:(authorizationId,contentHash,bytes)=>request('/v2/data/receipts',{authorizationId,contentHash,bytes})});
  try{
    await new Promise<void>((resolve,reject)=>{data.server.once('error',reject);data.server.listen(options.port??0,options.listenHost,()=>resolve());});
    const address=data.server.address();if(!address||typeof address==='string')throw Error('DATA_HOST_ADDRESS_INVALID');
    const host=isIP(options.advertisedHost)===6?'['+options.advertisedHost+']':options.advertisedHost;
    const proposal={address:'https://'+host+':'+address.port,certificate:identity.certificate};
    // Older installations keyed their cache by advertised address. Remove a legacy object
    // only after the stable cache has verified its bytes, or its own hard expiry passes.
    for(const entry of fs.readdirSync(path.dirname(storage),{withFileTypes:true})){
      if(!entry.isDirectory()||!/^[a-f0-9]{64}$/.test(entry.name))continue;
      const legacyDir=path.join(path.dirname(storage),entry.name,'cache');
      if(!fs.existsSync(legacyDir)||!fs.lstatSync(legacyDir).isDirectory())continue;
      const legacy=new ArtifactChannel(legacyDir,connection.domain,async()=>{throw Error('LOCAL_CACHE_ONLY');},schemas);
      legacy.sweep();
      for(const d of legacy.snapshot().objects){
        if(!legacy.available(d))continue;
        try{
          const bytes=await legacy.readForControl(d);data.channel.register(d);await data.channel.writeForControl(d,bytes);
          legacy.forget(d);
        }catch(error){
          if(!(error instanceof Error)||!['ARTIFACT_CACHE_FULL','ARTIFACT_IDENTITY_CONFLICT','ARTIFACT_CONTENT_INVALID','ARTIFACT_CORRUPT'].includes(error.message))throw error;
        }
      }
    }
    const register=async()=>{
      endpoint=null;
      const challenge=await request('/v2/data/endpoints/challenge',proposal) as {endpoint:DataEndpointIdentity};
      if(!validDataEndpoint(challenge.endpoint)||challenge.endpoint.certificate!==identity.certificate||challenge.endpoint.address!==proposal.address)throw Error('DATA_HOST_REGISTRATION_INVALID');
      const verified:string[]=[];
      for(const d of data.channel.snapshot(challenge.endpoint.groupId).objects){
        if(!data.channel.available(d))continue;
        try{await data.channel.readForControl(d);}
        catch(error){if(error instanceof Error&&['ARTIFACT_EXPIRED','ARTIFACT_CONTENT_INVALID'].includes(error.message))continue;throw error;}
        verified.push(transferDigest(canonical([d.ref,d.bytes])));
      }
      const proof=verified.length?{challenge,verified}: {challenge};
      const signature=sign('sha256',Buffer.from(canonical(verified.length?proof:challenge)),identity.key).toString('base64');
      const registered=await request('/v2/data/endpoints/register',{...proof,signature}) as DataEndpointIdentity;
      if(canonical(registered)!==canonical(challenge.endpoint))throw Error('DATA_HOST_REGISTRATION_INVALID');endpoint=registered;
    };
    await register();
    return {...data,identity:()=>endpoint,register,close:async()=>{endpoint=null;data.server.closeAllConnections();await new Promise<void>(resolve=>data.server.close(()=>resolve()));}};
  }catch(error){data.server.closeAllConnections();await new Promise<void>(resolve=>data.server.close(()=>resolve()));throw error;}
}
