import { CoordinatorDatabase, CoordinatorTransaction } from './CoordinatorDatabase';
import { CoordinatorPeer } from './CoordinatorCredentials';
import { canonical } from '../core/CanonicalV2';
import { vectorSumV2, vectorFitsV2 } from '../core/LedgerV2';
import { AllotmentGrantV2, AllotmentAckV2, ResourceAmountV2, validResourceVectorV2, validAllotmentGrantV2, validAllotmentAckV2 } from '../protocol/ResourcesV2';
export interface CoordinatorBudgetBinding {groupId:string;holderInstanceId:string;appInstanceId:string|null;}
export interface CoordinatorBudget {deviceId:string;capacity:ResourceAmountV2[];bindings:CoordinatorBudgetBinding[];}
export interface CoordinatorReservation {grant:AllotmentGrantV2;reserved:ResourceAmountV2[];ack:AllotmentAckV2|null;}
export interface CoordinatorGrantRequest {ledgerEpoch:number;leaseRequestId:string;leaseMs:number;base:ResourceAmountV2[];extra:ResourceAmountV2[];}
export interface CoordinatorGrantSigner {sign(payload:Object):Promise<string>;verifyAck(ack:AllotmentAckV2,tokenHash:string,signature:string):Promise<boolean>;}
interface Installation {id:string;holder:string;offline:ResourceAmountV2[];}
const key=(device:string):string=>JSON.stringify(['budget',device]);
const rowId=(group:string,holder:string):string=>JSON.stringify(['allotment',group,holder]);
function maximum(a:ResourceAmountV2[],b:ResourceAmountV2[]):ResourceAmountV2[]{return vectorSumV2(a,b).map((r:ResourceAmountV2):ResourceAmountV2=>({resourcePoolId:r.resourcePoolId,amount:Math.max(a.find(x=>x.resourcePoolId===r.resourcePoolId)?.amount??0,b.find(x=>x.resourcePoolId===r.resourcePoolId)?.amount??0)}));}
async function read(db:CoordinatorTransaction,table:string,id:string):Promise<string|null>{const rows=await db.querySql('SELECT metadataJson FROM '+table+' WHERE id=?',[id]);try{return rows.goToFirstRow()?rows.getString(0):null;}finally{rows.close();}}
async function reservations(db:CoordinatorTransaction,deviceId:string):Promise<CoordinatorReservation[]>{const rows=await db.querySql('SELECT id,metadataJson FROM Allotment');const result:CoordinatorReservation[]=[];try{while(rows.goToNextRow()){if(!rows.getString(0).startsWith('["allotment",'))continue;const r=JSON.parse(rows.getString(1)) as CoordinatorReservation;if(r.grant.deviceId===deviceId)result.push(r);}}finally{rows.close();}return result;}
async function installations(db:CoordinatorTransaction,deviceId:string):Promise<Installation[]>{const rows=await db.querySql('SELECT id,holderInstanceId,offlineJson FROM RegisteredInstallation WHERE deviceId=?',[deviceId]);const result:Installation[]=[];try{while(rows.goToNextRow())result.push({id:rows.getString(0),holder:rows.getString(1),offline:JSON.parse(rows.getString(2)) as ResourceAmountV2[]});}finally{rows.close();}return result;}
/** Same physical-budget ledger, reservation retention and acknowledgement fences as Windows. */
export class CoordinatorAllotments {
 private database:CoordinatorDatabase;
 private signer:CoordinatorGrantSigner;
 private epoch:number;
 constructor(database:CoordinatorDatabase,signer:CoordinatorGrantSigner,epoch:number){this.database=database;this.signer=signer;this.epoch=epoch;}
 async budget(deviceId:string):Promise<CoordinatorBudget|null>{let result:CoordinatorBudget|null=null;await this.database.transaction(async(db:CoordinatorTransaction):Promise<void>=>{const raw=await read(db,'Device',key(deviceId));if(raw!==null)result=JSON.parse(raw) as CoordinatorBudget;});return result;}
 async confirmDevice(deviceId:string,capacity:ResourceAmountV2[],bindings:CoordinatorBudgetBinding[]):Promise<void>{
  const validId=(id:string):boolean=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id);
  if(!validId(deviceId)||!validResourceVectorV2(capacity)||!capacity.length||!bindings.length||bindings.some(b=>!validId(b.groupId)||!validId(b.holderInstanceId)||b.appInstanceId!==null&&!validId(b.appInstanceId))||new Set(bindings.map(b=>b.holderInstanceId)).size!==bindings.length)throw Error('BUDGET_INVALID');
  await this.database.transaction(async(db:CoordinatorTransaction):Promise<void>=>{
   const all=await reservations(db,deviceId),pending=(await installations(db,deviceId)).filter(i=>!all.some(r=>r.grant.holderInstanceId===i.holder));
   if(!vectorFitsV2(vectorSumV2(...all.map(r=>r.reserved),...pending.map(i=>i.offline)),capacity))throw Error('BUDGET_RECONCILIATION_REQUIRED');
   if(all.some(r=>r.reserved.some(v=>v.amount>0)&&!bindings.some(b=>b.groupId===r.grant.groupId&&b.holderInstanceId===r.grant.holderInstanceId&&b.appInstanceId===r.grant.appInstanceId))||pending.some(i=>i.offline.some(v=>v.amount>0)&&!bindings.some(b=>b.holderInstanceId===i.holder&&b.appInstanceId===i.id)))throw Error('BINDING_HAS_UNSETTLED_RESERVATION');
   const budget:CoordinatorBudget={deviceId,capacity,bindings};await db.executeSql('INSERT INTO Device (id,groupId,revision,metadataJson) VALUES (?,\'physical-budget\',1,?) ON CONFLICT(id) DO UPDATE SET revision=revision+1,metadataJson=excluded.metadataJson',[key(deviceId),JSON.stringify(budget)]);
  });
 }
 async issue(peer:CoordinatorPeer,input:CoordinatorGrantRequest):Promise<AllotmentGrantV2>{
  if(!validResourceVectorV2(input.base)||!validResourceVectorV2(input.extra)||!Number.isSafeInteger(input.ledgerEpoch)||input.ledgerEpoch<1||!Number.isSafeInteger(input.leaseMs)||input.leaseMs<1||input.leaseMs>300000||typeof input.leaseRequestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.leaseRequestId))throw Error('REQUEST_INVALID');
  let result:AllotmentGrantV2|null=null;
  await this.database.transaction(async(db:CoordinatorTransaction):Promise<void>=>{
   const raw=await read(db,'Device',key(peer.deviceId)),budget:CoordinatorBudget|null=raw===null?null:JSON.parse(raw) as CoordinatorBudget;
   const binding=budget?.bindings.find(b=>b.groupId===peer.groupId&&b.holderInstanceId===peer.holderInstanceId);if(!budget||!binding)throw Error('IDENTITY_UNRESOLVED');
   if(binding.appInstanceId!==null){
    if(!peer.app||peer.app.appInstanceId!==binding.appInstanceId)throw Error('APP_ALLOTMENT_POLICY');
    const policy=await db.querySql('SELECT state,offlineJson,onlineJson,deviceId,groupId,holderInstanceId FROM RegisteredInstallation WHERE id=?',[binding.appInstanceId]);
    try{if(!policy.goToFirstRow()||policy.getString(0)!=='ACTIVE'||policy.getString(3)!==peer.deviceId||policy.getString(4)!==peer.groupId||policy.getString(5)!==peer.holderInstanceId||
      canonical(JSON.parse(policy.getString(1)) as ResourceAmountV2[])!==canonical(input.base)||!vectorFitsV2(input.extra,JSON.parse(policy.getString(2)) as ResourceAmountV2[]))throw Error('APP_ALLOTMENT_POLICY');}finally{policy.close();}
   }else{if(peer.app)throw Error('APP_ALLOTMENT_POLICY');if(input.base.some(v=>v.amount>0))throw Error('AGENT_BASE_FORBIDDEN');}
   const id=rowId(peer.groupId,peer.holderInstanceId),old=await read(db,'Allotment',id),previous:CoordinatorReservation|null=old===null?null:JSON.parse(old) as CoordinatorReservation;
   if(previous&&(previous.grant.deviceId!==peer.deviceId||previous.grant.appInstanceId!==binding.appInstanceId))throw Error('HOLDER_BINDING_CHANGED');
   if(previous&&input.leaseRequestId===previous.grant.leaseRequestId){const g=previous.grant;if(g.ledgerEpoch!==input.ledgerEpoch||g.coordinatorEpoch!==this.epoch||g.leaseMs!==input.leaseMs||canonical(g.base)!==canonical(input.base)||canonical(g.extra)!==canonical(input.extra))throw Error('LEASE_REQUEST_CONFLICT');result=g;return;}
   if(previous){const pending=await db.querySql('SELECT id FROM Attempt WHERE groupId=? AND holderInstanceId=? AND state=\'OFFERED\' LIMIT 1',[peer.groupId,peer.holderInstanceId]);try{if(pending.goToFirstRow())throw Error('DISPATCH_ADMISSION_PENDING');}finally{pending.close();}if(input.ledgerEpoch<previous.grant.ledgerEpoch)throw Error('LEDGER_EPOCH_REPLAY');}
   const grant:AllotmentGrantV2={allotmentId:previous?.grant.allotmentId??'allotment:'+peer.holderInstanceId,groupId:peer.groupId,deviceId:peer.deviceId,holderInstanceId:peer.holderInstanceId,appInstanceId:binding.appInstanceId,ledgerEpoch:input.ledgerEpoch,coordinatorEpoch:this.epoch,version:(previous?.grant.version??0)+1,base:input.base,extra:input.extra,leaseRequestId:input.leaseRequestId,leaseMs:input.leaseMs,signature:'A'.repeat(64)};
   if(!validAllotmentGrantV2(grant))throw Error('GRANT_INVALID');
   const desired=vectorSumV2(grant.base,grant.extra),reserved=previous?maximum(previous.reserved,desired):desired;
   const others=(await reservations(db,peer.deviceId)).filter(r=>r.grant.holderInstanceId!==peer.holderInstanceId||r.grant.groupId!==peer.groupId);
   const pending=(await installations(db,peer.deviceId)).filter(i=>i.holder!==peer.holderInstanceId&&!others.some(r=>r.grant.holderInstanceId===i.holder));
   if(!vectorFitsV2(vectorSumV2(reserved,...others.map(r=>r.reserved),...pending.map(i=>i.offline)),budget.capacity))throw Error('BUDGET_UNAVAILABLE');
   const fields=JSON.parse(JSON.stringify(grant)) as Record<string,Object|null>,unsigned:Record<string,Object|null>={};for(const field of Object.keys(fields))if(field!=='signature')unsigned[field]=fields[field];grant.signature=await this.signer.sign(unsigned);
   const state:CoordinatorReservation={grant,reserved,ack:previous?.ack??null};await db.executeSql('INSERT INTO Allotment (id,groupId,revision,metadataJson) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,metadataJson=excluded.metadataJson',[id,peer.groupId,grant.version,JSON.stringify(state)]);result=grant;
  });if(result===null)throw Error('GRANT_INVALID');return result;
 }
 async acknowledge(peer:CoordinatorPeer,ack:AllotmentAckV2,signature:string):Promise<void>{
  if(!validAllotmentAckV2(ack)||!ack.persisted||typeof signature!=='string')throw Error('ACK_INVALID');
  await this.database.transaction(async(db:CoordinatorTransaction):Promise<void>=>{
   const credentials=await db.querySql('SELECT revoked,tokenHash,groupId,holderInstanceId FROM Credential WHERE id=?',[peer.credentialId]);let tokenHash='';
   try{if(!credentials.goToFirstRow()||credentials.getLong(0)!==0||credentials.getString(2)!==peer.groupId||credentials.getString(3)!==peer.holderInstanceId)throw Error('ACK_UNAUTHORIZED');tokenHash=credentials.getString(1);}finally{credentials.close();}
   if(!await this.signer.verifyAck(ack,tokenHash,signature))throw Error('ACK_SIGNATURE');
   const id=rowId(peer.groupId,peer.holderInstanceId),raw=await read(db,'Allotment',id);if(raw===null)throw Error('ALLOTMENT_UNKNOWN');const state=JSON.parse(raw) as CoordinatorReservation,g=state.grant;
   if(g.deviceId!==peer.deviceId||ack.holderInstanceId!==g.holderInstanceId||ack.allotmentId!==g.allotmentId||ack.version!==g.version||ack.coordinatorEpoch!==g.coordinatorEpoch||ack.ledgerEpoch!==g.ledgerEpoch)throw Error('ACK_VERSION');
   if(state.ack&&(ack.settlementSeq<state.ack.settlementSeq||ack.settlementSeq===state.ack.settlementSeq&&canonical(ack.occupied)!==canonical(state.ack.occupied)))throw Error('ACK_REPLAY');
   if(!vectorFitsV2(ack.occupied,state.reserved))throw Error('OCCUPANCY_EXCEEDS_RESERVATION');state.ack=ack;state.reserved=maximum(vectorSumV2(g.base,g.extra),ack.occupied);
   await db.executeSql('UPDATE Allotment SET metadataJson=? WHERE id=?',[JSON.stringify(state),id]);
  });
 }
}
