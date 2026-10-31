import fs from 'node:fs';
export * from './evaluation-wire';
import path from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
import { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ArtifactRefV2, canonical, validArtifactRefV2, protocolId, fitLink, LinkObservation } from '@harmony/scheduler-core';

export interface ArtifactPeer {groupId:string;principalId:string;holderInstanceId:string;}
export interface ArtifactDescriptor {ref:ArtifactRefV2;groupId:string;ownerPrincipalId:string;bytes:number;expiresAt:number;domain:'REAL'|'SIMULATED';}
export interface ArtifactTicket {token:string;ref:ArtifactRefV2;bytes:number;expiresAt:number;operation:'READ'|'WRITE';}
export type ArtifactSchema=(bytes:Buffer)=>boolean|Promise<boolean>;
const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const key=(v:ArtifactDescriptor)=>hash(canonical([v.groupId,v.ref.artifactId,v.ref.contentVersion]));
function save(file:string,value:unknown){const temporary=file+'.'+randomUUID()+'.tmp',fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,file);}

/** Dedicated bounded data cache. No business credentials or transfer tokens are persisted. */
export class ArtifactChannel {
  private readonly objects=new Map<string,ArtifactDescriptor>();
  private readonly tickets=new Map<string,{descriptor:ArtifactDescriptor;peer:ArtifactPeer;operation:'READ'|'WRITE';expiresAt:number}>();
  private readonly busy=new Set<string>();
  private active=0;
  constructor(private readonly directory:string,readonly domain:'REAL'|'SIMULATED',private readonly authenticate:(credential:string)=>Promise<ArtifactPeer>,
    private readonly schemas:ReadonlyMap<string,ArtifactSchema>,private readonly now:()=>number=Date.now,
    readonly limits={objectBytes:8388608,cacheBytes:134217728,concurrent:4,maxTokens:1024}){
    fs.mkdirSync(directory,{recursive:true});
    for(const filename of fs.readdirSync(directory).filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){
      const descriptor=JSON.parse(fs.readFileSync(path.join(directory,filename),'utf8'));this.validate(descriptor);
      if(filename!==key(descriptor)+'.json')throw Error('ARTIFACT_METADATA_CORRUPT');this.objects.set(key(descriptor),descriptor);
    }
  }
  private validate(d:ArtifactDescriptor){
    if(!d||Object.keys(d).sort().join('|')!=='bytes|domain|expiresAt|groupId|ownerPrincipalId|ref'||!validArtifactRefV2(d.ref)||
      !protocolId(d.groupId)||!protocolId(d.ownerPrincipalId)||d.domain!==this.domain||!Number.isSafeInteger(d.bytes)||d.bytes<1||d.bytes>this.limits.objectBytes||
      !Number.isSafeInteger(d.expiresAt)||d.expiresAt<1||!this.schemas.has(d.ref.schemaId+':'+d.ref.schemaVersion))throw Error('ARTIFACT_DESCRIPTOR_INVALID');
  }
  /** Trusted local owner-policy operation; it is deliberately not an unauthenticated remote registration API. */
  register(d:ArtifactDescriptor){
    this.sweep();
    this.validate(d);if(d.expiresAt<=this.now())throw Error('ARTIFACT_EXPIRED');const id=key(d),old=this.objects.get(id);
    if(old&&canonical(old)!==canonical(d))throw Error('ARTIFACT_IDENTITY_CONFLICT');
    if(!old){if(this.objects.size>=4096)throw Error('ARTIFACT_METADATA_FULL');save(path.join(this.directory,id+'.json'),d);this.objects.set(id,structuredClone(d));}
  }
  /** Local control-plane lookup; callers still enforce task and data ownership before issuing a ticket. */
  lookup(groupId:string,ref:ArtifactRefV2):ArtifactDescriptor|null {
    const d=[...this.objects.values()].find(v=>v.groupId===groupId&&canonical(v.ref)===canonical(ref)&&v.expiresAt>this.now());
    return d?structuredClone(d):null;
  }
  available(d:ArtifactDescriptor):boolean{return canonical(this.objects.get(key(d)))===canonical(d)&&d.expiresAt>this.now()&&fs.existsSync(path.join(this.directory,key(d)+'.blob'));}
  /** In-process application gateway; callers must verify the authenticated job owner. */
  async writeForControl(d:ArtifactDescriptor,bytes:Buffer){
    if(canonical(this.objects.get(key(d)))!==canonical(d)||d.expiresAt<=this.now())throw Error('ARTIFACT_EXPIRED');
    await this.check(d,bytes);
    const filename=path.join(this.directory,key(d)+'.blob');
    if(fs.existsSync(filename)){if(hash(fs.readFileSync(filename))!==d.ref.contentHash)throw Error('ARTIFACT_CORRUPT');return;}
    const used=fs.readdirSync(this.directory).filter(n=>n.endsWith('.blob')).reduce((n,f)=>n+fs.statSync(path.join(this.directory,f)).size,0);
    if(used+bytes.length>this.limits.cacheBytes)throw Error('ARTIFACT_CACHE_FULL');
    const temporary=filename+'.'+randomUUID()+'.part';fs.writeFileSync(temporary,bytes,{flag:'wx',mode:0o600});fs.renameSync(temporary,filename);
  }
  async readForControl(d:ArtifactDescriptor){if(!this.available(d))throw Error('ARTIFACT_EXPIRED');const bytes=fs.readFileSync(path.join(this.directory,key(d)+'.blob'));await this.check(d,bytes);return bytes;}
  /** Caller must have already checked task/App/data-owner permission. Peer binding is checked again at transfer time. */
  issue(d:ArtifactDescriptor,peer:ArtifactPeer,operation:'READ'|'WRITE',ttlMs=30000):ArtifactTicket{
    this.validate(d);
    for(const [id,t] of this.tickets)if(t.expiresAt<=this.now())this.tickets.delete(id);
    if(!peer||peer.groupId!==d.groupId||![peer.groupId,peer.principalId,peer.holderInstanceId].every(protocolId)||!['READ','WRITE'].includes(operation)||
      !Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>60000||this.tickets.size>=this.limits.maxTokens||canonical(this.objects.get(key(d)))!==canonical(d))throw Error('ARTIFACT_GRANT_INVALID');
    const expiresAt=Math.min(d.expiresAt,this.now()+ttlMs);if(expiresAt<=this.now())throw Error('ARTIFACT_EXPIRED');
    const token=randomBytes(32).toString('base64url');this.tickets.set(hash(token),{descriptor:structuredClone(d),peer:{...peer},operation,expiresAt});
    return {token,ref:d.ref,bytes:d.bytes,expiresAt,operation};
  }
  private async authorize(request:IncomingMessage){
    const auth=request.headers.authorization,credential=request.headers['x-device-credential'];
    if(typeof auth!=='string'||!auth.startsWith('Bearer ')||typeof credential!=='string')throw Error('ARTIFACT_FORBIDDEN');
    const grant=this.tickets.get(hash(auth.slice(7))),peer=await this.authenticate(credential);
    if(!grant||grant.expiresAt<=this.now()||grant.descriptor.expiresAt<=this.now()||peer.groupId!==grant.peer.groupId||peer.principalId!==grant.peer.principalId||peer.holderInstanceId!==grant.peer.holderInstanceId)throw Error('ARTIFACT_FORBIDDEN');
    const route='/v2/artifacts/'+grant.descriptor.ref.artifactId+'/'+grant.descriptor.ref.contentVersion;
    if(request.url!==route||request.method!==(grant.operation==='READ'?'GET':'PUT'))throw Error('ARTIFACT_FORBIDDEN');
    return grant;
  }
  async handle(request:IncomingMessage,response:ServerResponse){
    if(this.active>=this.limits.concurrent){response.writeHead(429).end();return;}this.active++;
    let locked:string|undefined;
    try{
      const grant=await this.authorize(request),d=grant.descriptor,id=key(d),filename=path.join(this.directory,id+'.blob');
      if(grant.operation==='READ'){
        const bytes=fs.readFileSync(filename);await this.check(d,bytes);await this.authorize(request);
        response.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes.length,'Cache-Control':'no-store'}).end(bytes);return;
      }
      if(this.busy.has(id))throw Error('ARTIFACT_BUSY');this.busy.add(id);locked=id;
      if(request.headers['content-type']!=='application/octet-stream'||request.headers['content-length']!==String(d.bytes))throw Error('ARTIFACT_SIZE');
      let size=0;const chunks:Buffer[]=[];
      request.setTimeout(10000,()=>request.destroy());
      for await(const chunk of request){size+=chunk.length;if(size>d.bytes)throw Error('ARTIFACT_SIZE');chunks.push(Buffer.from(chunk));}
      const bytes=Buffer.concat(chunks);await this.check(d,bytes);await this.authorize(request);
      if(fs.existsSync(filename)){
        if(hash(fs.readFileSync(filename))!==d.ref.contentHash)throw Error('ARTIFACT_CORRUPT');response.writeHead(200).end();return;
      }
      const used=fs.readdirSync(this.directory).filter(n=>n.endsWith('.blob')||n.endsWith('.part')).reduce((n,f)=>n+fs.statSync(path.join(this.directory,f)).size,0);
      if(used+bytes.length>this.limits.cacheBytes)throw Error('ARTIFACT_CACHE_FULL');
      const temporary=filename+'.'+randomUUID()+'.part',fd=fs.openSync(temporary,'wx',0o600);
      try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,filename);
      response.writeHead(201).end();
    }catch{if(!response.headersSent)response.writeHead(403);response.end();}
    finally{if(locked)this.busy.delete(locked);this.active--;}
  }
  private async check(d:ArtifactDescriptor,bytes:Buffer){
    if(bytes.length!==d.bytes||hash(bytes)!==d.ref.contentHash||!await this.schemas.get(d.ref.schemaId+':'+d.ref.schemaVersion)!(bytes))throw Error('ARTIFACT_CONTENT_INVALID');
  }
  sweep(){
    for(const [id,d] of this.objects)if(d.expiresAt<=this.now()&&!this.busy.has(id)){
      for(const suffix of ['.json','.blob']){const file=path.join(this.directory,id+suffix);if(fs.existsSync(file))fs.unlinkSync(file);}this.objects.delete(id);
    }
  }
}

export interface PinnedEndpoint {address:string;certificate:string;fingerprint:string;tlsMode?:'pinned'|'public';}
export function pinOptions(endpoint:PinnedEndpoint):https.RequestOptions{
  const url=new URL(endpoint.address);
  if(url.protocol!=='https:'||url.pathname!=='/'||url.search||url.hash||url.username||url.password||
    new X509Certificate(endpoint.certificate).fingerprint256.replaceAll(':','').toLowerCase()!==endpoint.fingerprint)throw Error('ENDPOINT_INVALID');
  if(endpoint.tlsMode==='public')return {rejectUnauthorized:true};
  if(endpoint.tlsMode!==undefined&&endpoint.tlsMode!=='pinned')throw Error('TLS_MODE_INVALID');
  return {ca:endpoint.certificate,rejectUnauthorized:true,checkServerIdentity:(host,cert)=>tls.checkServerIdentity(host,cert)||
    (cert.fingerprint256?.replaceAll(':','').toLowerCase()===endpoint.fingerprint?undefined:Error('CERTIFICATE_PIN_MISMATCH'))};
}
export async function transfer(endpoint:PinnedEndpoint,ticket:ArtifactTicket,credential:string,bytes?:Buffer):Promise<{bytes:Buffer;durationMs:number}>{
  if(!ticket||!validArtifactRefV2(ticket.ref)||!Number.isSafeInteger(ticket.bytes)||ticket.bytes<1||ticket.bytes>8388608||
    !/^[A-Za-z0-9_-]{43}$/.test(ticket.token)||!['READ','WRITE'].includes(ticket.operation)||typeof credential!=='string'||
    (ticket.operation==='WRITE'?!bytes||bytes.length!==ticket.bytes||hash(bytes)!==ticket.ref.contentHash:bytes!==undefined))throw Error('TRANSFER_INVALID');
  const options=pinOptions(endpoint),started=performance.now();
  return new Promise((resolve,reject)=>{
    const request=https.request(new URL('/v2/artifacts/'+ticket.ref.artifactId+'/'+ticket.ref.contentVersion,endpoint.address),{
      ...options,method:ticket.operation==='READ'?'GET':'PUT',headers:{Authorization:'Bearer '+ticket.token,'X-Device-Credential':credential,
        ...(bytes?{'Content-Type':'application/octet-stream','Content-Length':bytes.length}:{})}},response=>{
      const chunks:Buffer[]=[];let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>ticket.bytes){request.destroy(Error('TRANSFER_SIZE'));return;}chunks.push(chunk);});
      response.on('error',reject);response.on('end',()=>{
        if(![200,201].includes(response.statusCode??0)){reject(Error('TRANSFER_REJECTED'));return;}
        const data=Buffer.concat(chunks);
        if(ticket.operation==='READ'&&(data.length!==ticket.bytes||hash(data)!==ticket.ref.contentHash)){reject(Error('TRANSFER_HASH'));return;}
        resolve({bytes:data,durationMs:performance.now()-started});
      });
    });request.setTimeout(10000,()=>request.destroy(Error('TRANSFER_TIMEOUT')));request.on('error',reject);request.end(bytes);
  });
}
/** Endpoints are supplied by a trusted route registry, never by an arbitrary URL in a task payload. */
export async function relay(source:PinnedEndpoint,read:ArtifactTicket,sourceCredential:string,destination:PinnedEndpoint,write:ArtifactTicket,destinationCredential:string){
  if(read.operation!=='READ'||write.operation!=='WRITE'||canonical(read.ref)!==canonical(write.ref)||read.bytes!==write.bytes)throw Error('RELAY_SCOPE');
  const received=await transfer(source,read,sourceCredential);const sent=await transfer(destination,write,destinationCredential,received.bytes);
  return {downloadMs:received.durationMs,uploadMs:sent.durationMs,bytes:read.bytes};
}
export class DirectionalLinks {
  private readonly samples=new Map<string,LinkObservation[]>();
  constructor(readonly domain:'REAL'|'SIMULATED'){}
  observe(from:string,to:string,networkEpoch:string,endNetworkEpoch:string,domain:string,row:LinkObservation){
    if(domain!==this.domain||![from,to,networkEpoch,endNetworkEpoch].every(protocolId)||from===to||!Number.isSafeInteger(row.bytes)||row.bytes<1||
      !Number.isFinite(row.durationMs)||row.durationMs<0||!Number.isFinite(row.observedAt))throw Error('LINK_OBSERVATION_INVALID');
    if(networkEpoch!==endNetworkEpoch)return;
    const id=canonical([from,to,networkEpoch]);if(!this.samples.has(id)&&this.samples.size>=512)throw Error('LINK_CAPACITY');
    this.samples.set(id,[...(this.samples.get(id)??[]),{...row}].slice(-64));
  }
  estimate(from:string,to:string,networkEpoch:string,now:number,ttlMs=30000){
    return fitLink((this.samples.get(canonical([from,to,networkEpoch]))??[]).filter(r=>r.observedAt<=now&&now-r.observedAt<=ttlMs),ttlMs);
  }
}
