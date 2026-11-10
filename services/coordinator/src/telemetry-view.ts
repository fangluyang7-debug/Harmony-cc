import {recentJobs,recentTransfers,traceRows} from './dashboard-history';
import {raceKey,raceIntervals} from './race-timing';
// Human install guidance per capability (data file; see capabilities/capability-hints.json).
const capabilityHints=require('../../../capabilities/capability-hints.json') as Record<string,{label?:string;install?:string}>;
import {PrismaClient} from '../generated/client';
import {DeviceDirectory} from './directory';
import {TraceService} from './traces';
import {Peer} from './channel';
import {availability,protocolId} from '@harmony/scheduler-core';
import {deviceMembershipActive} from './device-membership';

const parsed=(value:string|null|undefined)=>value?JSON.parse(value):null;
const finite=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)?value:null;
/** Member-authorized read projection. Never plans, registers Apps, issues tickets, or mutates state. */
export class TelemetryView {
  constructor(private db:PrismaClient,private directory:DeviceDirectory,
    private traces:TraceService,private networkView?:(groupId:string)=>Promise<unknown>){}

  async snapshot(groupId:string,principalId:string){
    const now=Date.now();
    const [space,registered,profiles,qualifications,rows,jobCount,graphs,network,peerNetworks,authorizations,endpoints,grantRows,batchRows]=await Promise.all([
      this.db.teamSpace.findUniqueOrThrow({where:{id:groupId}}),this.db.spaceDevice.findMany({where:{spaceId:groupId}}),
      this.directory.profiles(groupId),this.db.capabilityState.findMany({where:{groupId}}),recentJobs(this.db,groupId),
      this.db.cpuJob.count({where:{groupId}}),this.db.sdkWorkflowJob.findMany({where:{groupId}}),this.networkView?.(groupId)??[],this.db.peerNetwork.findMany({where:{groupId}}),
      recentTransfers(this.db,groupId),this.db.dataEndpoint.findMany({where:{groupId}}),this.db.allotment.findMany({where:{groupId}}),this.db.batchReadyJob.findMany({where:{groupId},select:{id:true,reason:true,queuedAt:true}})
    ]);
    const attempts=await this.db.attempt.findMany({where:{groupId,id:{in:rows.map(r=>r.id)}}});
    // A device that never redeemed its invite has no credential history: it is a pending invite, not a device.
    const pairedHolders=new Set((await this.db.credential.findMany({where:{groupId},select:{holderInstanceId:true}})).map(c=>c.holderInstanceId));
    const active=await Promise.all(registered.map(d=>deviceMembershipActive(this.db,d.id)));
    const ids=[...new Set([...registered.filter((_,i)=>active[i]).map(d=>d.id),...profiles.map(p=>p.deviceId)])];
    const grants=grantRows.filter(r=>r.id.startsWith('["allotment",')).map(r=>parsed(r.metadataJson));
    const devices=ids.map(id=>{
      const registration=registered.find(d=>d.id===id),holders=profiles.filter(p=>p.deviceId===id);
      const reservations=grants.filter(r=>r.grant.deviceId===id&&r.grant.groupId===groupId);
      return {id,name:registration?.name??id,paired:holders.length>0||(!!registration&&pairedHolders.has(registration.holderId)),holders:holders.map(profile=>({profile,controlState:this.directory.controlState?.(groupId,profile.holderInstanceId,profile.deviceInstanceId,profile.ledgerEpoch)??'UNKNOWN',
        resourceForecasts:profile.executors.map(e=>{const a=availability(profile,e,'REMOTE_INTERACTIVE',profile.sequence,now);return {targetId:a.targetId,reason:a.reason,blockingReason:a.blockingReason,resourceWait:a.resourceWait};}),
        evidenceFresh:profile.ownerActivity.sampledAt<=now&&profile.ownerActivity.sampledAt+profile.ownerActivity.ttlMs>now,
        qualification:profile.executors.map(e=>({targetId:e.target.targetId,...parsed(qualifications.find(q=>q.id===JSON.stringify([groupId,profile.holderInstanceId,e.target.targetId]))?.metadataJson)}))})),
        allotments:reservations.map(r=>({holderInstanceId:r.grant.holderInstanceId,appInstanceId:r.grant.appInstanceId,version:r.grant.version,coordinatorEpoch:r.grant.coordinatorEpoch,
          base:r.grant.base,extra:r.grant.extra,reserved:r.reserved,ack:r.ack?{version:r.ack.version,occupied:r.ack.occupied,settlementSeq:r.ack.settlementSeq}:null}))};
    });
    const racing=await this.db.node.findMany({where:{workflowId:{in:[...new Set(attempts.map(a=>a.workflowId))]},backupAttemptId:{not:null}}});
    const timingRows=racing.length?await this.db.costObservation.findMany({where:{groupId,id:{in:racing.map(n=>raceKey(n.id))}}}):[];
    const timings=new Map(timingRows.map(r=>[r.id,parsed(r.metadataJson)]));
    const raceByNode=new Map(racing.map(n=>[n.id,{primary:n.primaryAttemptId,backup:n.backupAttemptId,winner:n.winnerAttemptId,timing:timings.has(raceKey(n.id))?raceIntervals(timings.get(raceKey(n.id)),n.primaryAttemptId!,n.backupAttemptId!):null}]));
    const attemptById=new Map(attempts.map(a=>[a.id,a]));
    const batchByJob=new Map(batchRows.map(b=>[b.id,b]));
    const jobs=rows.map(row=>{
      const data=parsed(row.metadataJson),offer=data.offer,attempt=attemptById.get(row.id),record=parsed(attempt?.recordJson),rejection=parsed(attempt?.rejectionJson),yielded=parsed(attempt?.yieldJson);
      const decision=data.plan?.decision,batch=!attempt?batchByJob.get(row.id):undefined;
      return {id:row.id,workflowId:offer.task.workflowId,nodeId:offer.task.nodeId,capability:offer.task.contract.capability,
        state:attempt?.state??(batch?'QUEUED':row.state),queueReason:batch?.reason??null,queuedAt:batch?.queuedAt??null,targetId:offer.target.targetId,deviceId:offer.target.deviceId,holderInstanceId:data.holderId,originDeviceId:offer.task.originDeviceId,
        createdAt:finite(data.request?.now),traceId:data.traceId,traceOwner:row.principalId===principalId,
        reason:offer.reasonCode,recoveryEstimate:parsed(attempt?.recoveryEstimateJson),race:attempt?raceByNode.get(attempt.nodeId)??null:null,resourcesSettled:record?.resourcesSettled??null,
        rejection:rejection?{reasonCode:rejection.reasonCode??rejection.reply?.reasonCode??'UNKNOWN',receivedAt:finite(rejection.receivedAt)}:null,
        yield:yielded?{reasonCode:yielded.notice?.reasonCode??'UNKNOWN',receivedAt:finite(yielded.receivedAt)}:null,
        plan:data.plan?{snapshotVersion:data.plan.snapshotVersion,policyVersion:data.plan.policyVersion,
          status:decision?.status??'UNKNOWN',reason:decision?.reason??'UNKNOWN',baselineMs:finite(decision?.baselineMs),suggestionMs:finite(decision?.suggestionMs),
          baseline:decision?.baseline??null,suggestion:decision?.suggestion??null,rejections:decision?.rejections??[],planningMs:finite(decision?.planningMs)}:null,
        candidateCount:finite(data.decisionEvidence?.candidateCount),
        dataScope:data.privacy??'UNKNOWN',
        resultDelivery:data.decisionEvidence?.resultDelivery??'UNKNOWN',
        transfers:offer.transferPlan.map((hop:any)=>({from:hop.from,to:hop.to,via:hop.via})),
        selectedInputEndpoint:decision?.suggestion?.[0]?.inputEndpointId??null};
    }).sort((a,b)=>(b.createdAt??0)-(a.createdAt??0)||a.id.localeCompare(b.id));
    const links=peerNetworks.flatMap(row=>{
      const data=parsed(row.metadataJson);
      return (data.links??[]).map((link:any)=>({deviceId:data.deviceId,holderInstanceId:row.holderInstanceId,endpointId:link.endpointId,endpointDeviceId:parsed(endpoints.find(e=>e.id===link.endpointId)?.metadataJson)?.deviceId??null,direction:link.direction,reason:link.reason,
        observedAt:finite(link.observedAt),expiresAt:finite(link.expiresAt),estimate:link.estimate?{fixedMs:finite(link.estimate.fixedMs),bytesPerSecond:finite(link.estimate.bytesPerSecond)}:null}));
    });
    const transfers=authorizations.map(row=>{const a=parsed(row.metadataJson).authorization;return {id:row.id,jobId:row.attemptId,state:row.state,operation:a.operation,bytes:a.bytes,
      endpointDeviceId:a.endpoint.deviceId,requesterHolderId:a.requesterHolderId,issuedAt:a.issuedAt};}).sort((a,b)=>b.issuedAt-a.issuedAt).slice(0,100);
    const registeredApps=await this.db.registeredApp.findMany({where:{groupId},select:{id:true,label:true,declarationJson:true,contractsJson:true,maxConcurrent:true}});
    const installations=await this.db.registeredInstallation.findMany({where:{groupId},select:{id:true,appId:true,deviceId:true,state:true}});
    // Capability gaps: every contract some App declares, compared with what devices actually register and have qualified.
    // A gap is information for the device owner; the scheduler never dispatches to an unregistered device nor installs anything.
    const requiredBy=new Map<string,string[]>();
    for(const a of registeredApps)for(const c of (parsed(a.contractsJson)??[]) as string[])requiredBy.set(c,[...(requiredBy.get(c)??[]),a.label]);
    const order:Record<string,number>={MISSING:0,PENDING:1,READY:2};
    const capabilityGaps=[...requiredBy.entries()].map(([capability,requiredByApps])=>{
      const providers=devices.flatMap(d=>d.holders.flatMap(h=>h.profile.executors.filter((e:any)=>e.contract.contractId===capability||e.contract.capability===capability).map((e:any)=>{const q=h.qualification.find((x:any)=>x.targetId===e.target.targetId) as any;
        return {deviceId:d.id,deviceName:d.name,targetId:e.target.targetId,backend:e.target.backend,serviceId:e.contract.serviceId??null,state:q?.state??'DISCOVERED',reasonCode:q?.reasonCode??null};})));
      const qualified=providers.filter(p=>['CANARY','ACTIVE'].includes(p.state));
      const hint=(capabilityHints as Record<string,{label?:string;install?:string}>)[capability];
      return {capability,label:hint?.label??capability,requiredBy:requiredByApps,providers,qualifiedTargets:qualified.length,missingDevices:devices.filter(d=>!providers.some(p=>p.deviceId===d.id)).map(d=>({id:d.id,name:d.name})),
        status:qualified.length?'READY':providers.length?'PENDING':'MISSING',install:hint?.install??'该能力尚无能力包或执行器；需由能力提供方提供能力包、参考评测套件与执行器，再由设备主人在对应设备安装并登记。'};
    }).sort((a,b)=>order[a.status]-order[b.status]||a.capability.localeCompare(b.capability));
    return {version:1,space:{id:space.id,name:space.name},updatedAt:now,domain:this.directory.domain,devices,network,links,transfers,
      applications:registeredApps.map(a=>({id:a.id,label:a.label,declaration:parsed(a.declarationJson),contracts:parsed(a.contractsJson),maxConcurrent:a.maxConcurrent,installations:installations.filter(i=>i.appId===a.id)})),
      capabilityGaps,jobs:jobs.slice(0,100),jobWindow:100,jobCount,
      workflows:graphs.map(row=>{const d=parsed(row.metadataJson);return {id:row.id,state:row.state,nodes:d.nodes.map((n:any)=>({id:n.id,jobId:n.jobId,state:n.state}))};}),
      features:{hedging:'PURE_INTERACTIVE_RELAY_INPUT',reassignment:'AVAILABLE',candidateCosts:'PERSISTED_BASELINE_AND_SELECTED_ONLY',traceAccess:'EXISTING_PRINCIPAL_READERS',readOnly:true}};
  }

  async trace(peer:Peer,jobId:string){
    if(!protocolId(jobId))throw Error('JOB_INPUT_INVALID');
    const row=await this.db.cpuJob.findUnique({where:{id:jobId}});if(!row||row.groupId!==peer.groupId)throw Error('TRACE_FORBIDDEN');
    const data=parsed(row.metadataJson),rows=await traceRows(this.db,peer.groupId,data.traceId);
    const coverage={sourceSdkRoot:false,reasonCode:'SOURCE_SDK_ROOT_NOT_RECORDED'};
    if(!rows.some(r=>parsed(r.metadataJson).span.traceId===data.traceId))return {traceId:data.traceId,spans:[],analysis:null,state:'WAITING_FOR_EVIDENCE',coverage};
    // Coverage comes from the authenticated SDK root, not a structurally complete PLAN span.
    try{return {...await this.traces.read(peer,data.traceId),state:'RECORDED'};}catch(error){if(error instanceof Error&&error.message==='TRACE_UNAUTHORIZED')throw Error('TRACE_FORBIDDEN');throw error;}
  }
}
