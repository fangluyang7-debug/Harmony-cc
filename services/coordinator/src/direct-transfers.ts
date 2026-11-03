import {randomBytes, randomUUID, verify, X509Certificate} from 'node:crypto';
import {PrismaClient, Prisma} from '../generated/client';
import {canonical, protocolId, fitLink, PlacementLink, networkState, NetworkPairState} from '@harmony/scheduler-core';
import {ArtifactDescriptor, DataEndpointIdentity, SignedTransfer, TransferAuthorization, signTransfer, transferDigest, validDataEndpoint, verifyTransfer} from '@harmony/resource-transport';
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
      if(!await tx.dataEndpoint.findUnique({where:{id}})&&await tx.dataEndpoint.count({where:{groupId:peer.groupId}})>=64)throw Error('ENDPOINT_DIRECTORY_CAPACITY');
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
  async list(peer:Pick<Peer,'groupId'>,tx:Db=this.db){
    const rows=await tx.dataEndpoint.findMany({where:{groupId:peer.groupId,coordinatorEpoch:this.epoch()}}),result:DataEndpointIdentity[]=[];
    for(const row of rows){try{result.push(await this.endpoint(tx,row.id,peer.groupId));}catch{/* Revoked/stale endpoints are not candidates. */}}
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
      data.links.push({endpointId:endpoint.id,endpointEpoch:endpoint.epoch,direction:input.direction,reason:input.reason,observedAt:now,expiresAt:now+30000,estimate,samples:input.samples.map((s:any)=>({...s,observedAt:now})),observedIds:[]});
      await tx.peerNetwork.update({where:{id},data:{metadataJson:JSON.stringify(data)}});
    });return {recorded:true};
  }
  async failedLink(peer:Peer,input:{endpointId:string;endpointEpoch:string;reason:string}){
    if(!exact(input,['endpointId','endpointEpoch','reason'])||!['PEER_UNREACHABLE','TLS_MISMATCH','TIMEOUT'].includes(input.reason))throw Error('PEER_LINK_INVALID');
    const row=await this.db.peerNetwork.findUnique({where:{id:transferDigest(canonical([peer.groupId,peer.holderInstanceId]))}});
    if(!row)return this.resetNetwork(peer);
    return this.reportLink(peer,{epoch:JSON.parse(row.metadataJson).epoch,...input,direction:'WRITE',samples:[]});
  }
  /** Full HTTP duration includes online grant consumption and the receiver receipt. */
  async observe(peer:Peer,input:{authorizationId:string;durationMs:number}){
    if(!exact(input,['authorizationId','durationMs'])||!protocolId(input.authorizationId)||!Number.isFinite(input.durationMs)||input.durationMs<=0||input.durationMs>10000)throw Error('TRANSFER_OBSERVATION_INVALID');
    return this.db.$transaction(async tx=>{
      const grant=await tx.transferAuthorization.findUnique({where:{id:input.authorizationId}});
      if(!grant||grant.groupId!==peer.groupId||grant.requesterCredentialId!==peer.credentialId||grant.state!=='COMPLETED')throw Error('TRANSFER_OBSERVATION_SCOPE');
      await this.active(tx,peer.credentialId);
      const a=verifyTransfer(JSON.parse(grant.metadataJson),this.certificate,this.domain,this.now()),endpoint=await this.endpoint(tx,a.endpoint.id,peer.groupId);
      const id=transferDigest(canonical([peer.groupId,peer.holderInstanceId])),row=await tx.peerNetwork.findUnique({where:{id}}),data=row?JSON.parse(row.metadataJson):null;
      if(a.coordinatorEpoch!==this.epoch()||canonical(endpoint)!==canonical(a.endpoint)||!data||data.epoch!==a.networkEpoch||data.coordinatorEpoch!==a.coordinatorEpoch)throw Error('PEER_NETWORK_CHANGED');
      const link=data.links.find((l:any)=>l.endpointId===endpoint.id&&l.endpointEpoch===endpoint.epoch&&l.direction===a.operation);
      // A late observation must not revive failed or refreshed evidence.
      if(!link||link.reason!=='REACHABLE'||link.observedAt>a.issuedAt||link.expiresAt<=this.now())return {recorded:false};
      if((link.observedIds??[]).includes(a.id))return {recorded:false};
      const now=this.now(),samples=[...(link.samples??[]).filter((s:any)=>s.observedAt+30000>now),{bytes:a.bytes,durationMs:input.durationMs,observedAt:now}].slice(-8);
      const estimate=fitLink(samples,30000);if(!estimate)return {recorded:false};
      link.samples=samples;link.estimate=estimate;link.observedIds=[...(link.observedIds??[]),a.id].slice(-32);link.observedAt=now;link.expiresAt=now+30000;
      await tx.peerNetwork.update({where:{id},data:{metadataJson:JSON.stringify(data)}});return {recorded:true};
    });
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
          endpointId:endpoint.id,endpointEpoch:endpoint.epoch,endpointOperation:l.direction,bytesPerSecond:l.estimate.bytesPerSecond,fixedMs:l.estimate.fixedMs,effective:false,observedAt:l.observedAt,ttlMs:l.expiresAt-l.observedAt,source:this.domain});
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
      if(data.kind==='OUTPUT'){
        await this.active(this.db,data.producerCredentialId);
        const job=await this.db.cpuJob.findUnique({where:{id:data.attemptId}}),value=job?JSON.parse(job.metadataJson):null;
        const receipt=await this.db.receipt.findUnique({where:{id:data.attemptId}}),result=receipt?JSON.parse(receipt.recordJson):null;
        const node=value?await this.db.node.findUnique({where:{id:JSON.stringify([value.offer.task.workflowId,value.offer.task.nodeId])}}):null;
        const installation=await this.db.registeredInstallation.findUnique({where:{id:appInstanceId}});
        return !!(job&&job.groupId===groupId&&value.holderId===holderInstanceId&&value.offer.task.app.appInstanceId===appInstanceId&&
          installation?.state==='ACTIVE'&&installation.groupId===groupId&&installation.principalId===job.principalId&&
          value.output&&canonical(value.output.ref)===canonical(ref)&&node?.currentAttemptId===data.attemptId&&node?.state==='COMMITTED'&&
          receipt?.committed&&result?.state==='SUCCEEDED'&&result.outputs.some((r:any)=>canonical(r)===canonical(ref)));
      }
      const authorization=await this.db.transferAuthorization.findUnique({where:{id:data.authorizationId}});
      if(!authorization||authorization.state!=='COMPLETED')return false;await this.active(this.db,authorization.requesterCredentialId);return true;
    }catch{return false;}
  }
  async ownedEndpoint(peer:Peer){return this.endpoint(this.db,transferDigest(canonical([peer.groupId,peer.holderInstanceId])),peer.groupId);}
  /** Producer has already atomically stored and verified bytes; execution receipt still gates consumption. */
  async publishOutput(peer:Peer,attemptId:string,descriptor:ArtifactDescriptor){
    return this.db.$transaction(async tx=>{
      await this.active(tx,peer.credentialId);
      const endpoint=await this.endpoint(tx,transferDigest(canonical([peer.groupId,peer.holderInstanceId])),peer.groupId);
      const job=await tx.cpuJob.findUnique({where:{id:attemptId}}),data=job?JSON.parse(job.metadataJson):null,attempt=await tx.attempt.findUnique({where:{id:attemptId}});
      if(!job||job.groupId!==peer.groupId||job.state==='CANCEL_REQUESTED'||!attempt||!['OFFERED','ACCEPTED','RUNNING'].includes(attempt.state)||
        data.holderId!==peer.holderInstanceId||attempt.holderInstanceId!==peer.holderInstanceId||data.offer.target.deviceId!==peer.deviceId||
        data.offer.task.coordinatorEpoch!==this.epoch()||!data.output||canonical(data.output)!==canonical(descriptor)||
        data.retainOutput?.id!==endpoint.id||data.retainOutput?.epoch!==endpoint.epoch)throw Error('OUTPUT_REPLICA_SCOPE');
      const id=transferDigest(canonical([peer.groupId,descriptor.ref,endpoint.id,endpoint.epoch]));
      const metadataJson=JSON.stringify({kind:'OUTPUT',attemptId,producerCredentialId:peer.credentialId,ref:descriptor.ref,bytes:descriptor.bytes,
        endpoint,appInstanceId:data.offer.task.app.appInstanceId,verifiedAt:this.now(),expiresAt:descriptor.expiresAt});
      await tx.dataReplica.upsert({where:{id},create:{id,groupId:peer.groupId,endpointId:endpoint.id,metadataJson},update:{metadataJson}});
      return {recorded:true};
    });
  }
  async pendingDeliveries(peer:Peer){
    const endpoint=await this.ownedEndpoint(peer),items=[];
    for(const row of await this.db.cpuJob.findMany({where:{groupId:peer.groupId,state:'WAITING_INPUT'}})){
      const child=JSON.parse(row.metadataJson),edge=child.delivery,plan=child.plan?.decision?.suggestion?.[0];
      if(!edge||edge.senderHolderId!==peer.holderInstanceId||edge.senderEpoch!==endpoint.epoch||edge.senderEndpointId!==endpoint.id||child.deadlineAt<=this.now()||plan?.inputEndpointOperation!=='WRITE')continue;
      if(await this.hasInput(peer.groupId,child.holderId,child.offer.task.app.appInstanceId,child.input.ref))continue;
      const graph=await this.db.sdkWorkflowJob.findUnique({where:{id:child.offer.task.workflowId}});
      if(graph?.state!=='ACTIVE')continue;
      items.push({attemptId:row.id,deliveryId:edge.id,producerAttemptId:child.sourceAttemptId,endpointId:plan.inputEndpointId,ref:child.input.ref,bytes:child.input.bytes});
      if(items.length===8)break;
    }
    return items;
  }
  /** Recheck the graph edge and both endpoints in the same transaction that issues or burns a grant. */
  private async deliveryScope(tx:Db,peer:Peer,childId:string,deliveryId:string,endpoint:DataEndpointIdentity){
    const child=await tx.cpuJob.findUnique({where:{id:childId}});
    if(!child||child.groupId!==peer.groupId||child.state!=='WAITING_INPUT')throw Error('DELIVERY_UNAVAILABLE');
    const c=JSON.parse(child.metadataJson),edge=c.delivery;
    if(!edge||edge.id!==deliveryId||edge.senderHolderId!==peer.holderInstanceId||!c.sourceAttemptId||
      c.deadlineAt<=this.now()||c.input.expiresAt<c.deadlineAt||c.offer.task.coordinatorEpoch!==this.epoch())throw Error('DELIVERY_SCOPE');
    const graph=await tx.sdkWorkflowJob.findUnique({where:{id:c.offer.task.workflowId}});
    if(!graph||graph.state!=='ACTIVE'||graph.groupId!==child.groupId||graph.sourceHolderId!==child.sourceHolderId)throw Error('DELIVERY_SCOPE');
    const plan=c.plan?.decision?.suggestion?.[0];
    if(plan?.inputEndpointOperation!=='WRITE'||plan.inputEndpointId!==endpoint.id||plan.inputEndpointEpoch!==endpoint.epoch||
      c.holderId!==endpoint.holderInstanceId||c.offer.target.deviceId!==endpoint.deviceId)throw Error('TRANSFER_PLAN_CHANGED');
    const parent=await tx.cpuJob.findUnique({where:{id:c.sourceAttemptId}});
    if(!parent||parent.groupId!==child.groupId||parent.principalId!==child.principalId||parent.sourceHolderId!==child.sourceHolderId)throw Error('DELIVERY_SCOPE');
    const p=JSON.parse(parent.metadataJson),task=c.offer.task,definition=JSON.parse(graph.metadataJson).workflow.nodes.find((n:{id:string})=>n.id===task.nodeId);
    if(!definition||definition.inputFrom!==c.sourceNodeId||p.offer.task.nodeId!==definition.inputFrom||p.offer.task.workflowId!==task.workflowId||
      p.offer.task.app.appInstanceId!==task.app.appInstanceId||canonical(c.input)!==canonical(p.output)||!definition.dependsOn.includes(definition.inputFrom))throw Error('DELIVERY_SCOPE');
    const installation=await tx.registeredInstallation.findUnique({where:{id:task.app.appInstanceId}});
    if(installation?.state!=='ACTIVE'||installation.groupId!==child.groupId||installation.principalId!==child.principalId||installation.holderInstanceId!==child.sourceHolderId)throw Error('DELIVERY_SCOPE');
    for(const dependency of definition.dependsOn){
      const node=await tx.node.findUnique({where:{id:JSON.stringify([task.workflowId,dependency])}});
      if(node?.state!=='COMMITTED'||!node.currentAttemptId)throw Error('DELIVERY_DEPENDENCY');
      const receipt=await tx.receipt.findUnique({where:{id:node.currentAttemptId}}),result=receipt&&JSON.parse(receipt.recordJson);
      if(!receipt?.committed||result.state!=='SUCCEEDED'||dependency===definition.inputFrom&&(node.currentAttemptId!==parent.id||!result.outputs.some((ref:unknown)=>canonical(ref)===canonical(c.input.ref))))throw Error('DELIVERY_DEPENDENCY');
    }
    const sender=await this.endpoint(tx,edge.senderEndpointId,peer.groupId);
    if(sender.epoch!==edge.senderEpoch||sender.holderInstanceId!==peer.holderInstanceId||sender.deviceId!==peer.deviceId)throw Error('DELIVERY_SOURCE_CHANGED');
    const key=transferDigest(canonical([peer.groupId,c.input.ref,sender.id,sender.epoch]));
    const replica=await tx.dataReplica.findUnique({where:{id:key}}),r=replica&&JSON.parse(replica.metadataJson);
    if(!r||r.kind!=='OUTPUT'||r.attemptId!==parent.id||r.appInstanceId!==installation.id||r.expiresAt<=this.now()||r.bytes!==c.input.bytes||canonical(r.ref)!==canonical(c.input.ref)||canonical(r.endpoint)!==canonical(sender))throw Error('DELIVERY_SOURCE_CHANGED');
    await this.active(tx,r.producerCredentialId);
    return {offer:c.offer,descriptor:c.input,producerAttemptId:parent.id,deadlineAt:c.deadlineAt};
  }
  /** Source App may transfer only its own job input to, or committed output from, the selected host. */
  private async scope(tx:Db,peer:Peer,id:string,operation:'READ'|'WRITE',endpoint:DataEndpointIdentity){
    const row=await tx.cpuJob.findUnique({where:{id}}),d=row?JSON.parse(row.metadataJson):null;
    if(operation==='READ'&&row?.groupId===peer.groupId&&d?.sourceAttemptId&&d.holderId===peer.holderInstanceId){
      // A selected downstream holder may read only its declared, committed input.
      // It does not acquire the originating App's credentials or general read access.
      const attempt=await tx.attempt.findUnique({where:{id}}),parent=await tx.cpuJob.findUnique({where:{id:d.sourceAttemptId}});
      const p=parent?JSON.parse(parent.metadataJson):null,receipt=await tx.receipt.findUnique({where:{id:d.sourceAttemptId}}),result=receipt?JSON.parse(receipt.recordJson):null;
      const installation=await tx.registeredInstallation.findUnique({where:{id:d.offer.task.app.appInstanceId}});
      const app=installation?await tx.registeredApp.findUnique({where:{id:installation.appId}}):null;
      const parentNode=p?await tx.node.findUnique({where:{id:JSON.stringify([p.offer.task.workflowId,p.offer.task.nodeId])}}):null;
      if(!attempt||attempt.holderInstanceId!==peer.holderInstanceId||!['OFFERED','ACCEPTED','RUNNING'].includes(attempt.state)||row.state==='CANCEL_REQUESTED'||
        d.offer.target.deviceId!==peer.deviceId||d.offer.task.coordinatorEpoch!==this.epoch()||d.deadlineAt<=this.now()||
        !installation||installation.state!=='ACTIVE'||installation.groupId!==peer.groupId||installation.principalId!==row.principalId||installation.holderInstanceId!==row.sourceHolderId||
        !app||app.id!==d.offer.task.app.appId||!JSON.parse(app.contractsJson).includes(d.offer.task.contract.contractId)||
        !parent||parent.groupId!==row.groupId||parent.principalId!==row.principalId||parent.sourceHolderId!==row.sourceHolderId||
        p.offer.task.workflowId!==d.offer.task.workflowId||p.offer.task.app.appInstanceId!==d.offer.task.app.appInstanceId||
        p.holderId!==endpoint.holderInstanceId||p.offer.target.deviceId!==endpoint.deviceId||
        !d.offer.dependencies.some((dependency:any)=>dependency.nodeId===p.offer.task.nodeId&&dependency.committed===true)||
        parentNode?.currentAttemptId!==d.sourceAttemptId||parentNode?.state!=='COMMITTED'||!receipt?.committed||result?.state!=='SUCCEEDED'||!p.output||!result.outputs.some((ref:any)=>canonical(ref)===canonical(p.output.ref))||
        canonical(d.input.ref)!==canonical(p.output.ref)||d.input.bytes!==p.output.bytes)throw Error('TRANSFER_DEPENDENCY_SCOPE');
      const chosen=d.plan?.decision?.suggestion?.[0];
      if(chosen?.inputEndpointId!==endpoint.id||chosen?.inputEndpointEpoch!==endpoint.epoch||chosen?.inputEndpointOperation!=='READ')throw Error('TRANSFER_PLAN_CHANGED');
      return {offer:d.offer,descriptor:p.output};
    }
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
  async issue(peer:Peer,input:{attemptId:string;endpointId:string;operation:'READ'|'WRITE';deliveryId?:string}){
    if(!exact(input,['attemptId','endpointId','operation',...(input?.deliveryId!==undefined?['deliveryId']:[])])||input.deliveryId!==undefined&&(!protocolId(input.deliveryId)||input.operation!=='WRITE')||![input.attemptId,input.endpointId].every(protocolId)||!['READ','WRITE'].includes(input.operation))throw Error('TRANSFER_REQUEST_INVALID');
    return this.db.$transaction(async tx=>{
      const requester=await this.active(tx,peer.credentialId),endpoint=await this.endpoint(tx,input.endpointId,peer.groupId);
      await tx.transferAuthorization.deleteMany({where:{groupId:peer.groupId,expiresAt:{lt:this.now()-3600000}}});
      if(await tx.transferAuthorization.count({where:{requesterCredentialId:peer.credentialId,state:'ISSUED',expiresAt:{gt:this.now()}}})>=128||
        await tx.transferAuthorization.count({where:{groupId:peer.groupId}})>=16384)throw Error('TRANSFER_AUTHORIZATION_CAPACITY');
      const delivery=input.deliveryId?await this.deliveryScope(tx,requester,input.attemptId,input.deliveryId,endpoint):undefined;
      const {offer,descriptor}=delivery??await this.scope(tx,requester,input.attemptId,input.operation,endpoint),proof=randomBytes(32).toString('base64url'),now=this.now();
      const networkRow=await tx.peerNetwork.findUnique({where:{id:transferDigest(canonical([peer.groupId,peer.holderInstanceId]))}}),network=networkRow?JSON.parse(networkRow.metadataJson):null;
      if(!network||network.coordinatorEpoch!==this.epoch())throw Error('PEER_NETWORK_CHANGED');
      const authorization:TransferAuthorization={...(delivery?{version:2 as const,deliveryId:input.deliveryId,producerAttemptId:delivery.producerAttemptId,artifactExpiresAt:descriptor.expiresAt}:{version:1 as const}),id:randomUUID(),domain:this.domain,coordinatorEpoch:this.epoch(),networkEpoch:network.epoch,workflowId:offer.task.workflowId,attemptId:input.attemptId,
        appInstanceId:offer.task.app.appInstanceId,groupId:peer.groupId,ownerPrincipalId:descriptor.ownerPrincipalId,requesterHolderId:peer.holderInstanceId,
        senderHolderId:input.operation==='WRITE'?peer.holderInstanceId:endpoint.holderInstanceId,receiverHolderId:input.operation==='READ'?peer.holderInstanceId:endpoint.holderInstanceId,
        endpoint,ref:descriptor.ref,bytes:descriptor.bytes,operation:input.operation,proofHash:transferDigest(proof),issuedAt:now,expiresAt:Math.min(now+30000,descriptor.expiresAt,delivery?.deadlineAt??Infinity)};
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
      const networkRow=await tx.peerNetwork.findUnique({where:{id:transferDigest(canonical([a.groupId,a.requesterHolderId]))}}),network=networkRow?JSON.parse(networkRow.metadataJson):null;
      if(!network||network.epoch!==a.networkEpoch||network.coordinatorEpoch!==a.coordinatorEpoch)throw Error('PEER_NETWORK_CHANGED');
      const scope=a.version===2?await this.deliveryScope(tx,requester,a.attemptId,a.deliveryId!,endpoint):await this.scope(tx,requester,a.attemptId,a.operation,endpoint);
      if(a.version===2&&(!('producerAttemptId' in scope)||scope.producerAttemptId!==a.producerAttemptId))throw Error('DELIVERY_SCOPE');
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
      const requester=await this.active(tx,row.requesterCredentialId);
      if(row.state==='COMPLETED')return {committed:true};
      if(a.version===2){
        const edge=await this.deliveryScope(tx,requester,a.attemptId,a.deliveryId!,endpoint);
        if(edge.producerAttemptId!==a.producerAttemptId||canonical(edge.descriptor.ref)!==canonical(a.ref)||edge.descriptor.expiresAt!==a.artifactExpiresAt)throw Error('DELIVERY_SCOPE');
      }
      if(a.operation==='WRITE'){
        const id=transferDigest(canonical([a.groupId,a.ref,endpoint.id,endpoint.epoch]));
        const metadataJson=JSON.stringify({ref:a.ref,bytes:a.bytes,endpoint,appInstanceId:a.appInstanceId,authorizationId:a.id,verifiedAt:this.now(),expiresAt:Math.min(this.now()+30000,a.artifactExpiresAt??Infinity)});
        await tx.dataReplica.upsert({where:{id},create:{id,groupId:a.groupId,endpointId:endpoint.id,metadataJson},update:{metadataJson}});
      }
      await tx.transferAuthorization.update({where:{id:a.id},data:{state:'COMPLETED'}});return {committed:true};
    });
  }
}
