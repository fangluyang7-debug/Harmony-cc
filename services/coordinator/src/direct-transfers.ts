import {randomBytes, randomUUID, verify, X509Certificate} from 'node:crypto';
import {PrismaClient, Prisma} from '../generated/client';
import {canonical, protocolId, fitLink, PlacementLink, networkState, NetworkPairState} from '@harmony/scheduler-core';
import {DataEndpointIdentity, SignedTransfer, TransferAuthorization, signTransfer, transferDigest, validDataEndpoint, verifyTransfer} from '@harmony/resource-transport';
import {Peer} from './channel';

type Db=Prisma.TransactionClient;
interface Challenge {endpoint:DataEndpointIdentity; nonce:string; expiresAt:number; coordinatorEpoch:number;}
const exact=(v:any,keys:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
/** Control-plane metadata only. Byte traffic and endpoint private keys never enter this service. */
export class DirectTransfers {
  private readonly challenges=new Map<string,Challenge>();
  constructor(private readonly db:PrismaClient,private readonly key:string,private readonly certificate:string,
    private readonly domain:'REAL'|'SIMULATED',private readonly epoch:()=>number,private readonly now=Date.now){}
  challenge(peer:Peer,input:{address:string;certificate:string}){
    if(!exact(input,['address','certificate'])||typeof input.certificate!=='string'||input.certificate.length>16384)throw Error('ENDPOINT_INVALID');
    const cert=new X509Certificate(input.certificate);
    if(cert.publicKey.asymmetricKeyType!=='rsa'||(cert.publicKey.asymmetricKeyDetails?.modulusLength??0)<2048||Date.parse(cert.validFrom)>this.now()||Date.parse(cert.validTo)<=this.now())throw Error('ENDPOINT_CERTIFICATE_INVALID');
    const endpoint:DataEndpointIdentity={id:transferDigest(canonical([peer.groupId,peer.holderInstanceId])),groupId:peer.groupId,
      holderInstanceId:peer.holderInstanceId,deviceId:peer.deviceId,epoch:randomUUID(),address:input.address,certificate:input.certificate,
      fingerprint:cert.fingerprint256.replaceAll(':','').toLowerCase()};
    if(!validDataEndpoint(endpoint)||endpoint.fingerprint===new X509Certificate(this.certificate).fingerprint256.replaceAll(':','').toLowerCase())throw Error('ENDPOINT_INVALID');
    for(const [id,c] of this.challenges)if(c.expiresAt<=this.now())this.challenges.delete(id);
    if(!this.challenges.has(endpoint.id)&&this.challenges.size>=128)throw Error('ENDPOINT_CHALLENGE_CAPACITY');
    const value={endpoint,nonce:randomBytes(32).toString('base64url'),expiresAt:this.now()+30000,coordinatorEpoch:this.epoch()};
    this.challenges.set(endpoint.id,value);return structuredClone(value);
  }
  async register(peer:Peer,input:{challenge:Challenge;signature:string}){
    if(!exact(input,['challenge','signature'])||typeof input.signature!=='string'||input.signature.length>2048)throw Error('ENDPOINT_PROOF_INVALID');
    const id=transferDigest(canonical([peer.groupId,peer.holderInstanceId])),pending=this.challenges.get(id);
    if(!pending||pending.expiresAt<=this.now()||pending.coordinatorEpoch!==this.epoch()||canonical(pending)!==canonical(input.challenge)||
      !verify('sha256',Buffer.from(canonical(pending)),new X509Certificate(pending.endpoint.certificate).publicKey,Buffer.from(input.signature,'base64')))throw Error('ENDPOINT_PROOF_INVALID');
    this.challenges.delete(id);
    await this.db.$transaction(async tx=>{
      await this.active(tx,peer.credentialId);
      await tx.dataEndpoint.upsert({where:{id},create:{id,groupId:peer.groupId,holderInstanceId:peer.holderInstanceId,credentialId:peer.credentialId,coordinatorEpoch:this.epoch(),metadataJson:JSON.stringify(pending.endpoint)},
        update:{credentialId:peer.credentialId,coordinatorEpoch:this.epoch(),metadataJson:JSON.stringify(pending.endpoint)}});
      await tx.transferAuthorization.updateMany({where:{endpointId:id,state:'ISSUED'},data:{state:'REVOKED'}});
      await tx.dataReplica.deleteMany({where:{endpointId:id}});
    });return pending.endpoint;
  }
  private async active(tx:Db,id:string):Promise<Peer>{
    const credential=await tx.credential.findUnique({where:{id}}),data=credential?JSON.parse(credential.metadataJson):null;
    if(!credential||credential.revoked||!data||data.expiresAt<=this.now()||data.domain!==this.domain)throw Error('TRANSFER_CREDENTIAL_REVOKED');
    const peer:Peer=data.peer;
    if(peer.app){
      const installation=await tx.registeredInstallation.findUnique({where:{id:peer.app.appInstanceId}});
      if(!installation||installation.state!=='ACTIVE'||installation.holderInstanceId!==peer.holderInstanceId||installation.groupId!==peer.groupId||
        installation.principalId!==peer.principalId||installation.deviceId!==peer.deviceId||installation.appId!==peer.app.appId||
        !await tx.registeredApp.findUnique({where:{id:installation.appId}}))throw Error('TRANSFER_APP_REVOKED');
    }
    return peer;
  }
  private async endpoint(tx:Db,id:string,groupId:string){
    const row=await tx.dataEndpoint.findUnique({where:{id}});
    if(!row||row.groupId!==groupId||row.coordinatorEpoch!==this.epoch())throw Error('ENDPOINT_UNAVAILABLE');
    const peer=await this.active(tx,row.credentialId),endpoint:DataEndpointIdentity=JSON.parse(row.metadataJson);
    if(!validDataEndpoint(endpoint)||peer.holderInstanceId!==endpoint.holderInstanceId||Date.parse(new X509Certificate(endpoint.certificate).validTo)<=this.now())throw Error('ENDPOINT_UNAVAILABLE');
    return endpoint;
  }
  async list(peer:Peer){
    const rows=await this.db.dataEndpoint.findMany({where:{groupId:peer.groupId,coordinatorEpoch:this.epoch()}}),result:DataEndpointIdentity[]=[];
    for(const row of rows){try{result.push(await this.endpoint(this.db,row.id,peer.groupId));}catch{/* Revoked/stale endpoints are not candidates. */}}
    return result;
  }
  async resetNetwork(peer:Peer){
    const id=transferDigest(canonical([peer.groupId,peer.holderInstanceId])),epoch=randomUUID();
    const metadataJson=JSON.stringify({epoch,coordinatorEpoch:this.epoch(),links:[],deviceId:peer.deviceId});
    await this.db.peerNetwork.upsert({where:{id},create:{id,groupId:peer.groupId,holderInstanceId:peer.holderInstanceId,credentialId:peer.credentialId,metadataJson},update:{credentialId:peer.credentialId,metadataJson}});
    return {epoch};
  }
  async reportLink(peer:Peer,input:any){
    if(!exact(input,['epoch','endpointId','endpointEpoch','direction','reason','samples'])||![input.epoch,input.endpointId,input.endpointEpoch].every(protocolId)||
      !['READ','WRITE'].includes(input.direction)||!['REACHABLE','PEER_UNREACHABLE','TLS_MISMATCH','TIMEOUT'].includes(input.reason)||
      !Array.isArray(input.samples)||input.samples.length>6||input.samples.some((s:any)=>!exact(s,['bytes','durationMs'])||![1024,8192,32768].includes(s.bytes)||!Number.isFinite(s.durationMs)||s.durationMs<=0||s.durationMs>10000)||
      (input.reason==='REACHABLE'?input.samples.length<3:input.samples.length!==0))throw Error('PEER_LINK_INVALID');
    const id=transferDigest(canonical([peer.groupId,peer.holderInstanceId]));
    await this.db.$transaction(async tx=>{
      const endpoint=await this.endpoint(tx,input.endpointId,peer.groupId),row=await tx.peerNetwork.findUnique({where:{id}}),data=row?JSON.parse(row.metadataJson):null;
      if(!data||data.epoch!==input.epoch||data.coordinatorEpoch!==this.epoch()||endpoint.epoch!==input.endpointEpoch||endpoint.deviceId===peer.deviceId)throw Error('PEER_NETWORK_CHANGED');
      const now=this.now(),estimate=input.reason==='REACHABLE'?fitLink(input.samples.map((s:any)=>({...s,observedAt:now})),30000):null;
      if(input.reason==='REACHABLE'&&!estimate)throw Error('PEER_COST_UNKNOWN');
      data.links=data.links.filter((l:any)=>l.endpointId!==endpoint.id||l.direction!==input.direction);
      if(data.links.length>=128)throw Error('PEER_LINK_CAPACITY');
      data.links.push({endpointId:endpoint.id,endpointEpoch:endpoint.epoch,direction:input.direction,reason:input.reason,observedAt:now,expiresAt:now+30000,estimate});
      await tx.peerNetwork.update({where:{id},data:{metadataJson:JSON.stringify(data)}});
    });return {recorded:true};
  }
  async failedLink(peer:Peer,input:{endpointId:string;endpointEpoch:string;reason:string}){
    if(!exact(input,['endpointId','endpointEpoch','reason'])||!['PEER_UNREACHABLE','TLS_MISMATCH','TIMEOUT'].includes(input.reason))throw Error('PEER_LINK_INVALID');
    const row=await this.db.peerNetwork.findUnique({where:{id:transferDigest(canonical([peer.groupId,peer.holderInstanceId]))}});
    if(!row)return this.resetNetwork(peer);
    return this.reportLink(peer,{epoch:JSON.parse(row.metadataJson).epoch,...input,direction:'WRITE',samples:[]});
  }
  async links(tx:Db,groupId:string):Promise<PlacementLink[]>{
    const rows=await tx.peerNetwork.findMany({where:{groupId}}),links:PlacementLink[]=[],now=this.now();
    for(const row of rows){
      const data=JSON.parse(row.metadataJson);if(data.coordinatorEpoch!==this.epoch())continue;
      try{await this.active(tx,row.credentialId);}catch{continue;}
      for(const l of data.links){
        if(l.reason!=='REACHABLE'||!l.estimate||l.observedAt>now||l.expiresAt<=now)continue;
        let endpoint;try{endpoint=await this.endpoint(tx,l.endpointId,groupId);}catch{continue;}
        if(endpoint.epoch!==l.endpointEpoch)continue;
        links.push({from:l.direction==='WRITE'?data.deviceId:endpoint.deviceId,to:l.direction==='READ'?data.deviceId:endpoint.deviceId,
          fromHolderInstanceId:l.direction==='WRITE'?row.holderInstanceId:endpoint.holderInstanceId,toHolderInstanceId:l.direction==='READ'?row.holderInstanceId:endpoint.holderInstanceId,
          endpointId:endpoint.id,endpointEpoch:endpoint.epoch,bytesPerSecond:l.estimate.bytesPerSecond,fixedMs:l.estimate.fixedMs,effective:false,observedAt:l.observedAt,ttlMs:l.expiresAt-l.observedAt,source:this.domain});
      }
    }return links;
  }
  async network(peer:Peer){
    const endpoints=(await this.list(peer)).filter(e=>e.deviceId!==peer.deviceId),id=transferDigest(canonical([peer.groupId,peer.holderInstanceId]));
    const row=await this.db.peerNetwork.findUnique({where:{id}}),data=row?JSON.parse(row.metadataJson):null,now=this.now(),pairs:NetworkPairState[]=[];
    for(const endpoint of endpoints)for(const direction of ['READ','WRITE']){
      const link=data?.coordinatorEpoch===this.epoch()?data.links.find((l:any)=>l.endpointId===endpoint.id&&l.endpointEpoch===endpoint.epoch&&l.direction===direction):null;
      pairs.push({from:direction==='WRITE'?peer.deviceId:endpoint.deviceId,to:direction==='READ'?peer.deviceId:endpoint.deviceId,reason:link?.reason??'EVIDENCE_MISSING',observedAt:link?.observedAt??now,expiresAt:link?.expiresAt??now+1});
    }
    const profiles=(await this.db.deviceInstance.findMany({where:{groupId:peer.groupId}})).filter(r=>r.id.startsWith('["profile",')).map(r=>JSON.parse(r.metadataJson));
    for(const profile of profiles){
      if(profile.deviceId===peer.deviceId||endpoints.some(e=>e.deviceId===profile.deviceId)||pairs.some(p=>p.to===profile.deviceId))continue;
      pairs.push({from:peer.deviceId,to:profile.deviceId,reason:'NO_DATA_ENDPOINT',observedAt:now,expiresAt:now+30000});
    }
    return networkState('REACHABLE',pairs,now);
  }
  async dashboard(groupId:string){
    const rows=await this.db.credential.findMany({where:{groupId,revoked:false}}),result=[];
    const profiles=(await this.db.deviceInstance.findMany({where:{groupId}})).filter(r=>r.id.startsWith('["profile",')).map(r=>JSON.parse(r.metadataJson)),seen=new Set<string>();
    for(const row of rows){
      let peer;try{peer=await this.active(this.db,row.id);}catch{continue;}
      if(seen.has(peer.holderInstanceId))continue;seen.add(peer.holderInstanceId);
      const profile=profiles.find(p=>p.holderInstanceId===peer.holderInstanceId);if(!profile)continue;
      const state=profile.ownerActivity.sampledAt+profile.ownerActivity.ttlMs>this.now()?await this.network(peer):networkState('UNKNOWN',[],this.now());
      result.push({deviceId:peer.deviceId,holderInstanceId:peer.holderInstanceId,...state});
    }return result;
  }
  async hasInput(groupId:string,holderInstanceId:string,appInstanceId:string,ref:TransferAuthorization['ref']){
    try{
      const id=transferDigest(canonical([groupId,holderInstanceId])),endpoint=await this.endpoint(this.db,id,groupId);
      const key=transferDigest(canonical([groupId,ref,endpoint.id,endpoint.epoch])),row=await this.db.dataReplica.findUnique({where:{id:key}});
      if(!row)return false;const data=JSON.parse(row.metadataJson);
      if(data.appInstanceId!==appInstanceId||data.expiresAt<=this.now()||canonical(data.ref)!==canonical(ref)||canonical(data.endpoint)!==canonical(endpoint))return false;
      const authorization=await this.db.transferAuthorization.findUnique({where:{id:data.authorizationId}});
      if(!authorization||authorization.state!=='COMPLETED')return false;await this.active(this.db,authorization.requesterCredentialId);return true;
    }catch{return false;}
  }
  /** Source App may transfer only its own job input to, or committed output from, the selected host. */
  private async scope(tx:Db,peer:Peer,id:string,operation:'READ'|'WRITE',endpoint:DataEndpointIdentity){
    const row=await tx.cpuJob.findUnique({where:{id}}),d=row?JSON.parse(row.metadataJson):null;
    if(!row||row.groupId!==peer.groupId||row.principalId!==peer.principalId||row.sourceHolderId!==peer.holderInstanceId||
      !peer.app||d.offer.task.app.appInstanceId!==peer.app.appInstanceId||d.holderId!==endpoint.holderInstanceId||d.offer.target.deviceId!==endpoint.deviceId||d.offer.task.coordinatorEpoch!==this.epoch())throw Error('TRANSFER_JOB_SCOPE');
    if(operation==='WRITE'){
      const chosen=d.plan?.decision?.suggestion?.[0];
      if(chosen?.inputEndpointId!==endpoint.id||chosen?.inputEndpointEpoch!==endpoint.epoch)throw Error('TRANSFER_PLAN_CHANGED');
      if(!['WAITING_INPUT','DISPATCHING','DISPATCHED'].includes(row.state)||d.deadlineAt<=this.now())throw Error('TRANSFER_JOB_EXPIRED');
    }else{
      const receipt=await tx.receipt.findUnique({where:{id}}),value=receipt?JSON.parse(receipt.recordJson):null;
      if(!receipt?.committed||value?.state!=='SUCCEEDED'||!d.output||!value.outputs.some((r:any)=>canonical(r)===canonical(d.output.ref)))throw Error('TRANSFER_OUTPUT_UNCOMMITTED');
    }
    return {offer:d.offer,descriptor:operation==='WRITE'?d.input:d.output};
  }
  async issue(peer:Peer,input:{attemptId:string;endpointId:string;operation:'READ'|'WRITE'}){
    if(!exact(input,['attemptId','endpointId','operation'])||![input.attemptId,input.endpointId].every(protocolId)||!['READ','WRITE'].includes(input.operation))throw Error('TRANSFER_REQUEST_INVALID');
    return this.db.$transaction(async tx=>{
      const requester=await this.active(tx,peer.credentialId),endpoint=await this.endpoint(tx,input.endpointId,peer.groupId);
      const {offer,descriptor}=await this.scope(tx,requester,input.attemptId,input.operation,endpoint),proof=randomBytes(32).toString('base64url'),now=this.now();
      const authorization:TransferAuthorization={version:1,id:randomUUID(),domain:this.domain,coordinatorEpoch:this.epoch(),workflowId:offer.task.workflowId,attemptId:input.attemptId,
        appInstanceId:offer.task.app.appInstanceId,groupId:peer.groupId,ownerPrincipalId:peer.principalId,requesterHolderId:peer.holderInstanceId,
        senderHolderId:input.operation==='WRITE'?peer.holderInstanceId:endpoint.holderInstanceId,receiverHolderId:input.operation==='READ'?peer.holderInstanceId:endpoint.holderInstanceId,
        endpoint,ref:descriptor.ref,bytes:descriptor.bytes,operation:input.operation,proofHash:transferDigest(proof),issuedAt:now,expiresAt:Math.min(now+30000,descriptor.expiresAt)};
      const signed=signTransfer(authorization,this.key);
      await tx.transferAuthorization.create({data:{id:authorization.id,groupId:peer.groupId,attemptId:input.attemptId,endpointId:endpoint.id,requesterCredentialId:peer.credentialId,state:'ISSUED',expiresAt:authorization.expiresAt,metadataJson:JSON.stringify(signed)}});
      return {signed,proof};
    });
  }
  async consume(peer:Peer,input:{signed:SignedTransfer;proof:string}){
    if(!exact(input,['signed','proof'])||typeof input.proof!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.proof))throw Error('TRANSFER_PROOF_INVALID');
    const a=verifyTransfer(input.signed,this.certificate,this.domain,this.now());
    if(a.coordinatorEpoch!==this.epoch()||transferDigest(input.proof)!==a.proofHash)throw Error('TRANSFER_PROOF_INVALID');
    await this.db.$transaction(async tx=>{
      const endpoint=await this.endpoint(tx,a.endpoint.id,peer.groupId);
      if(endpoint.holderInstanceId!==peer.holderInstanceId||canonical(endpoint)!==canonical(a.endpoint))throw Error('TRANSFER_ENDPOINT_SCOPE');
      const row=await tx.transferAuthorization.findUnique({where:{id:a.id}});
      if(!row||row.state!=='ISSUED'||row.expiresAt<=this.now()||canonical(JSON.parse(row.metadataJson))!==canonical(input.signed))throw Error('TRANSFER_ALREADY_USED');
      const requester=await this.active(tx,row.requesterCredentialId);
      const scope=await this.scope(tx,requester,a.attemptId,a.operation,endpoint);
      if(canonical(scope.descriptor.ref)!==canonical(a.ref)||scope.descriptor.bytes!==a.bytes)throw Error('TRANSFER_JOB_SCOPE');
      const changed=await tx.transferAuthorization.updateMany({where:{id:a.id,state:'ISSUED'},data:{state:'CONSUMED'}});
      if(changed.count!==1)throw Error('TRANSFER_ALREADY_USED');
    });return {accepted:true,authorizationId:a.id};
  }
  async receipt(peer:Peer,input:{authorizationId:string;contentHash:string;bytes:number}){
    if(!exact(input,['authorizationId','contentHash','bytes'])||!protocolId(input.authorizationId))throw Error('TRANSFER_RECEIPT_INVALID');
    return this.db.$transaction(async tx=>{
      const row=await tx.transferAuthorization.findUnique({where:{id:input.authorizationId}});
      if(!row||row.groupId!==peer.groupId||!['CONSUMED','COMPLETED'].includes(row.state))throw Error('TRANSFER_RECEIPT_SCOPE');
      const a=verifyTransfer(JSON.parse(row.metadataJson),this.certificate,this.domain,this.now()),endpoint=await this.endpoint(tx,a.endpoint.id,peer.groupId);
      if(a.coordinatorEpoch!==this.epoch()||canonical(endpoint)!==canonical(a.endpoint)||a.receiverHolderId!==peer.holderInstanceId||input.contentHash!==a.ref.contentHash||input.bytes!==a.bytes)throw Error('TRANSFER_RECEIPT_SCOPE');
      await this.active(tx,row.requesterCredentialId);
      if(a.operation==='WRITE'){
        const id=transferDigest(canonical([a.groupId,a.ref,endpoint.id,endpoint.epoch]));
        const metadataJson=JSON.stringify({ref:a.ref,bytes:a.bytes,endpoint,appInstanceId:a.appInstanceId,authorizationId:a.id,verifiedAt:this.now(),expiresAt:this.now()+30000});
        await tx.dataReplica.upsert({where:{id},create:{id,groupId:a.groupId,endpointId:endpoint.id,metadataJson},update:{metadataJson}});
      }
      await tx.transferAuthorization.update({where:{id:a.id},data:{state:'COMPLETED'}});return {committed:true};
    });
  }
}
