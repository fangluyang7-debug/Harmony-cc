import { createHmac, sign, timingSafeEqual } from 'node:crypto';
import { PrismaClient } from '../generated/client';
import { AllotmentGrantV2, AllotmentAckV2, ResourceAmountV2, canonical, protocolId, validAllotmentGrantV2, validAllotmentAckV2, validResourceVectorV2, vectorSumV2, vectorFitsV2 } from '@harmony/scheduler-core';
import { Peer } from './channel';

interface Binding {groupId:string;holderInstanceId:string;appInstanceId:string|null;}
interface Budget {deviceId:string;capacity:ResourceAmountV2[];bindings:Binding[];}
interface Reservation {grant:AllotmentGrantV2;reserved:ResourceAmountV2[];ack:AllotmentAckV2|null;}
const key=(deviceId:string)=>JSON.stringify(['budget',deviceId]);
const rowId=(group:string,holder:string)=>JSON.stringify(['allotment',group,holder]);
function maximum(a:ResourceAmountV2[],b:ResourceAmountV2[]):ResourceAmountV2[]{
  return vectorSumV2(a,b).map(r=>({resourcePoolId:r.resourcePoolId,amount:Math.max(a.find(x=>x.resourcePoolId===r.resourcePoolId)?.amount??0,b.find(x=>x.resourcePoolId===r.resourcePoolId)?.amount??0)}));
}
export function allotmentAckSignature(ack:AllotmentAckV2,tokenHash:string):string{return createHmac('sha256',Buffer.from(tokenHash,'hex')).update(canonical(ack)).digest('base64');}
/** Trusted local policy API. There is deliberately no unauthenticated device-binding endpoint. */
export class AllotmentIssuer {
  constructor(private readonly db:PrismaClient,private readonly privateKey:string,private readonly epoch:()=>number){}
  async confirmDevice(deviceId:string,capacity:ResourceAmountV2[],bindings:Binding[]){
    if(!protocolId(deviceId)||!validResourceVectorV2(capacity)||!capacity.length||!bindings.length||bindings.some(b=>!protocolId(b.groupId)||!protocolId(b.holderInstanceId)||b.appInstanceId!==null&&!protocolId(b.appInstanceId))||new Set(bindings.map(b=>b.holderInstanceId)).size!==bindings.length||new Set(bindings.filter(b=>b.appInstanceId!==null).map(b=>b.appInstanceId)).size!==bindings.filter(b=>b.appInstanceId!==null).length)throw Error('BUDGET_INVALID');
    await this.db.$transaction(async tx=>{
      const all=(await tx.allotment.findMany()).filter(r=>r.id.startsWith('["allotment",')).map(r=>JSON.parse(r.metadataJson) as Reservation).filter(r=>r.grant.deviceId===deviceId);
      if(!vectorFitsV2(vectorSumV2(...all.map(r=>r.reserved)),capacity))throw Error('BUDGET_RECONCILIATION_REQUIRED');
      if(all.some(r=>r.reserved.some(v=>v.amount>0)&&!bindings.some(b=>b.groupId===r.grant.groupId&&b.holderInstanceId===r.grant.holderInstanceId&&b.appInstanceId===r.grant.appInstanceId)))throw Error('BINDING_HAS_UNSETTLED_RESERVATION');
      const metadataJson=JSON.stringify({deviceId,capacity,bindings} satisfies Budget),id=key(deviceId);
      await tx.device.upsert({where:{id},create:{id,groupId:'physical-budget',revision:1,metadataJson},update:{revision:{increment:1},metadataJson}});
    });
  }
  async issue(peer:Peer,input:{ledgerEpoch:number;leaseRequestId:string;leaseMs:number;base:ResourceAmountV2[];extra:ResourceAmountV2[]}):Promise<AllotmentGrantV2>{
    if(!validResourceVectorV2(input.base)||!validResourceVectorV2(input.extra))throw Error('RESOURCE_VECTOR_INVALID');
    return this.db.$transaction(async tx=>{
      const device=await tx.device.findUnique({where:{id:key(peer.deviceId)}}),budget:Budget|null=device?JSON.parse(device.metadataJson):null;
      const binding=budget?.bindings.find(b=>b.groupId===peer.groupId&&b.holderInstanceId===peer.holderInstanceId);
      if(!budget||!binding)throw Error('IDENTITY_UNRESOLVED');
      if(binding.appInstanceId===null&&input.base.some(v=>v.amount>0))throw Error('AGENT_BASE_FORBIDDEN');
      const id=rowId(peer.groupId,peer.holderInstanceId),row=await tx.allotment.findUnique({where:{id}}),previous:Reservation|null=row?JSON.parse(row.metadataJson):null;
      if(previous&&(previous.grant.deviceId!==peer.deviceId||previous.grant.appInstanceId!==binding.appInstanceId))throw Error('HOLDER_BINDING_CHANGED');
      if(previous&&input.leaseRequestId===previous.grant.leaseRequestId){
        const g=previous.grant;
        if(g.ledgerEpoch!==input.ledgerEpoch||g.coordinatorEpoch!==this.epoch()||g.leaseMs!==input.leaseMs||canonical(g.base)!==canonical(input.base)||canonical(g.extra)!==canonical(input.extra))throw Error('LEASE_REQUEST_CONFLICT');
        return g;
      }
      if(previous&&await tx.attempt.findFirst({where:{groupId:peer.groupId,holderInstanceId:peer.holderInstanceId,state:'OFFERED'}}))throw Error('DISPATCH_ADMISSION_PENDING');
      if(previous&&input.ledgerEpoch<previous.grant.ledgerEpoch)throw Error('LEDGER_EPOCH_REPLAY');
      const grant:AllotmentGrantV2={allotmentId:previous?.grant.allotmentId??'allotment:'+peer.holderInstanceId,groupId:peer.groupId,deviceId:peer.deviceId,holderInstanceId:peer.holderInstanceId,appInstanceId:binding.appInstanceId,
        ledgerEpoch:input.ledgerEpoch,coordinatorEpoch:this.epoch(),version:(previous?.grant.version??0)+1,base:input.base,extra:input.extra,leaseRequestId:input.leaseRequestId,leaseMs:input.leaseMs,signature:'A'.repeat(64)};
      if(!validAllotmentGrantV2(grant))throw Error('GRANT_INVALID');
      const desired=vectorSumV2(grant.base,grant.extra),reserved=previous?maximum(previous.reserved,desired):desired;
      const others=(await tx.allotment.findMany()).filter(r=>r.id.startsWith('["allotment",')&&r.id!==id).map(r=>JSON.parse(r.metadataJson) as Reservation).filter(r=>r.grant.deviceId===peer.deviceId);
      if(!vectorFitsV2(vectorSumV2(reserved,...others.map(r=>r.reserved)),budget.capacity))throw Error('BUDGET_UNAVAILABLE');
      const {signature,...unsigned}=grant;grant.signature=sign('sha256',Buffer.from(canonical(unsigned)),this.privateKey).toString('base64');
      const metadataJson=JSON.stringify({grant,reserved,ack:previous?.ack??null} satisfies Reservation);
      await tx.allotment.upsert({where:{id},create:{id,groupId:peer.groupId,revision:grant.version,metadataJson},update:{revision:grant.version,metadataJson}});
      return grant;
    });
  }
  /** Authenticated persisted acknowledgement. Expiry alone never calls this release path. */
  async acknowledge(peer:Peer,ack:AllotmentAckV2,signature:string){
    if(!validAllotmentAckV2(ack)||!ack.persisted||typeof signature!=='string')throw Error('ACK_INVALID');
    await this.db.$transaction(async tx=>{
      const credential=await tx.credential.findUnique({where:{id:peer.credentialId}});
      if(!credential||credential.revoked||!credential.tokenHash||credential.groupId!==peer.groupId||credential.holderInstanceId!==peer.holderInstanceId)throw Error('ACK_UNAUTHORIZED');
      const received=Buffer.from(signature,'base64'),expected=Buffer.from(allotmentAckSignature(ack,credential.tokenHash),'base64');
      if(received.length!==expected.length||!timingSafeEqual(received,expected))throw Error('ACK_SIGNATURE');
      const id=rowId(peer.groupId,peer.holderInstanceId),row=await tx.allotment.findUnique({where:{id}});if(!row)throw Error('ALLOTMENT_UNKNOWN');
      const state=JSON.parse(row.metadataJson) as Reservation,g=state.grant;
      if(g.deviceId!==peer.deviceId||ack.holderInstanceId!==g.holderInstanceId||ack.allotmentId!==g.allotmentId||ack.version!==g.version||ack.coordinatorEpoch!==g.coordinatorEpoch||ack.ledgerEpoch!==g.ledgerEpoch)throw Error('ACK_VERSION');
      if(state.ack&&(ack.settlementSeq<state.ack.settlementSeq||ack.settlementSeq===state.ack.settlementSeq&&canonical(ack.occupied)!==canonical(state.ack.occupied)))throw Error('ACK_REPLAY');
      if(!vectorFitsV2(ack.occupied,state.reserved))throw Error('OCCUPANCY_EXCEEDS_RESERVATION');
      state.ack=ack;state.reserved=maximum(vectorSumV2(g.base,g.extra),ack.occupied);
      await tx.allotment.update({where:{id},data:{metadataJson:JSON.stringify(state)}});
    });
  }
  async reservations(deviceId:string):Promise<Reservation[]>{return (await this.db.allotment.findMany()).filter(r=>r.id.startsWith('["allotment",')).map(r=>JSON.parse(r.metadataJson) as Reservation).filter(r=>r.grant.deviceId===deviceId);}
}
