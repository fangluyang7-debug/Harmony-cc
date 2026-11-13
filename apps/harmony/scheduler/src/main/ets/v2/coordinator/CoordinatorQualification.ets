import { coordinatorReferenceScore } from './CoordinatorReferenceVerifier';
import { TargetV2, TaskContractV2 } from '../protocol/SchedulingProtocolV2';
import { util } from '@kit.ArkTS';
import { CoordinatorDatabase, CoordinatorTransaction } from './CoordinatorDatabase';
import { CoordinatorPeer } from './CoordinatorCredentials';
import { DeviceProfileV2, ExecutorV2, CapabilityPackV2, CapabilityAdmissionV2, ExecutionConfigV2, sampleUsableV2, ModelManifestV2, ResourceAmountV2 } from '../protocol/ResourcesV2';
import { canonical } from '../core/CanonicalV2';
import { hash, bytes } from '../platform/NativeTransport';
interface EvaluationClaim {work:EvaluationWork|null;}
interface EvaluationStatus {cancel:boolean;settled:boolean;}
interface EvaluationAck {acknowledged:boolean;}
interface ExecutorIdentity {target:TargetV2;contract:TaskContractV2;model:ModelManifestV2|null;resources:ResourceAmountV2[];configurations:ExecutionConfigV2[];}
interface ReferenceExpectation {kind:string;errorCode?:string;}
interface ReferenceCase {id:string;input:string;config:ExecutionConfigV2;maxOutputBytes:number;expect:ReferenceExpectation;expected?:Object|null;}
interface ReferencePack {manifest:CapabilityPackV2;digest:string;cases:ReferenceCase[];}
interface EvaluationPermit {id:string;groupId:string;holderInstanceId:string;targetId:string;identity:string;packDigest:string;caseId:string;inputHash:string;config:ExecutionConfigV2;maxOutputBytes:number;timeoutMs:number;domain:string;}
interface EvaluationWork {permit:EvaluationPermit;executor:ExecutorV2;coordinatorEpoch:number;ledgerEpoch:number;deviceInstanceId:string;expiresAt:number;mode:string;}
export interface EvaluationReport {settled:boolean;output:string;durationMs:number;permitId:string;domain:string;errorCode?:string;interrupted?:boolean;overheadMs?:number;notRun?:boolean;}
interface QualificationState {admission:CapabilityAdmissionV2;ledgerEpoch:number;deviceInstanceId:string;packDigest:string;next:number;durations:number[];scores?:number[];}
export interface CoordinatorQualificationEvidence {executor:ExecutorV2;admission:CapabilityAdmissionV2;computeMs:number|null;}
export function coordinatorExecutorIdentity(executor:ExecutorV2):string{return hash(bytes(canonical({target:executor.target,contract:executor.contract,model:executor.model,resources:executor.resources,configurations:executor.configurations} as ExecutorIdentity)));}
const stateKey=(group:string,holder:string,target:string):string=>JSON.stringify(['native-qualification',group,holder,target]);
/** Durable reference-case evaluation. Advertisements alone never qualify an executor. */
export class CoordinatorQualification {
 private packs:ReferencePack[];
 onChanged:((group:string,holder:string)=>void)|null=null;
 private database:CoordinatorDatabase;
 private epoch:number;
 constructor(database:CoordinatorDatabase,packJson:string,epoch:number){this.database=database;this.epoch=epoch;this.packs=JSON.parse(packJson) as ReferencePack[];}
 private pack(executor:ExecutorV2):ReferencePack|undefined {
  // Reference metrics are reproduced with native byte and image decoders.
  const supported=['vector.normalize.v1','text.count.v1','render.fractal.v1','catalog.filter.v1','image.visual-match.v1','image.crop.v1','photo.analyze.v1','photo.prepare.v1','photo.enhance.v1','photo.assemble.v1','photo.deliver.v1'];
  const installed=this.packs.find(p=>supported.includes(p.manifest.contract.capability)&&p.manifest.contract.contractId===executor.contract.contractId&&canonical(p.manifest.contract)===canonical(executor.contract)&&canonical(p.manifest.model)===canonical(executor.model)&&p.manifest.executorIds.includes(executor.target.executorId)&&p.cases.every(c=>c.expect.kind==='REJECT'||c.expected!==undefined));
  if(!installed)return undefined;
  const cases=installed.cases.filter(c=>executor.configurations.some(config=>canonical(config)===canonical(c.config)));
  if(!cases.length||executor.configurations.some(config=>!cases.some(c=>canonical(config)===canonical(c.config))))return undefined;
  return {manifest:installed.manifest,digest:installed.digest,cases};
 }
 async profile(tx:CoordinatorTransaction,peer:CoordinatorPeer):Promise<DeviceProfileV2|null>{const rows=await tx.querySql('SELECT metadataJson FROM DeviceInstance WHERE id=?',[JSON.stringify(['profile',peer.groupId,peer.holderInstanceId])]);try{return rows.goToFirstRow()?JSON.parse(rows.getString(0)) as DeviceProfileV2:null;}finally{rows.close();}}
 private async state(tx:CoordinatorTransaction,peer:CoordinatorPeer,profile:DeviceProfileV2,executor:ExecutorV2):Promise<QualificationState>{
  const identity=coordinatorExecutorIdentity(executor),pack=this.pack(executor),key=stateKey(peer.groupId,peer.holderInstanceId,executor.target.targetId);
  const rows=await tx.querySql('SELECT metadataJson FROM CapabilityState WHERE id=?',[key]);let old:QualificationState|null=null;try{if(rows.goToFirstRow())old=JSON.parse(rows.getString(0)) as QualificationState;}finally{rows.close();}
  if(old&&old.admission.identity===identity&&old.ledgerEpoch===profile.ledgerEpoch&&old.deviceInstanceId===profile.deviceInstanceId&&old.packDigest===pack?.digest&&(old.admission.state!=='ACTIVE'||sampleUsableV2(old.admission.quality,Date.now(),'REAL')))return old;
  return {admission:{groupId:peer.groupId,holderInstanceId:peer.holderInstanceId,targetId:executor.target.targetId,identity,domain:'REAL',revision:(old?.admission.revision??0)+1,state:pack?'CALIBRATING':'WAITING_MODEL',reasonCode:pack?'REFERENCE_EVALUATION_REQUIRED':'NATIVE_REFERENCE_VERIFIER_UNAVAILABLE',quality:{value:null,source:'UNKNOWN',sampledAt:Date.now(),ttlMs:3600000,unit:'score'}},ledgerEpoch:profile.ledgerEpoch,deviceInstanceId:profile.deviceInstanceId,packDigest:pack?.digest??'',next:0,durations:[]};
 }
 private async save(tx:CoordinatorTransaction,state:QualificationState):Promise<void>{const a=state.admission;await tx.executeSql('INSERT INTO CapabilityState (id,groupId,revision,metadataJson) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,metadataJson=excluded.metadataJson',[stateKey(a.groupId,a.holderInstanceId,a.targetId),a.groupId,a.revision,JSON.stringify(state)]);}
 async evidence(tx:CoordinatorTransaction,peer:CoordinatorPeer,target:string,knownProfile:DeviceProfileV2|null=null):Promise<CoordinatorQualificationEvidence>{
  const profile=knownProfile??await this.profile(tx,peer),executor=profile?.executors.find(e=>e.target.targetId===target);if(!profile||!executor)throw Error('TARGET_UNKNOWN');
  const state=await this.state(tx,peer,profile,executor);if(state.admission.state!=='ACTIVE')await this.save(tx,state);
  return {executor,admission:state.admission,computeMs:state.durations.length?state.durations.reduce((a,b)=>a+b,0)/state.durations.length:null};
 }
 async claim(peer:CoordinatorPeer):Promise<Object>{
  let work:EvaluationWork|null=null;
  await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{
   const pending=await tx.querySql("SELECT workJson FROM EvaluationDispatch WHERE groupId=? AND holderInstanceId=? AND state='CLAIMED' ORDER BY rowid LIMIT 1",[peer.groupId,peer.holderInstanceId]);
   try{if(pending.goToFirstRow()){work=JSON.parse(pending.getString(0)) as EvaluationWork;work.mode='RECONCILE';return;}}finally{pending.close();}
   const profile=await this.profile(tx,peer),now=Date.now();
   if(!profile||this.database.controlState?.(peer.groupId,peer.holderInstanceId,profile.deviceInstanceId,profile.ledgerEpoch)!=='ONLINE'||!sampleUsableV2(profile.ownerActivity,now,'REAL')||profile.ownerActivity.value!=='IDLE'||profile.inFlight?.length||profile.queued?.length)return;
   for(const executor of profile.executors){
    const pack=this.pack(executor);if(!pack)continue;
    const state=await this.state(tx,peer,profile,executor);if(['ACTIVE','SUSPENDED'].includes(state.admission.state))continue;
    const test=pack.cases[state.next];if(!test)continue;
    const permit:EvaluationPermit={id:util.generateRandomUUID(true),groupId:peer.groupId,holderInstanceId:peer.holderInstanceId,targetId:executor.target.targetId,identity:state.admission.identity,packDigest:pack.digest,caseId:test.id,inputHash:hash(test.input?new util.Base64Helper().decodeSync(test.input):new Uint8Array(0)),config:test.config,maxOutputBytes:test.maxOutputBytes,timeoutMs:30000,domain:'REAL'};
    work={permit,executor,coordinatorEpoch:this.epoch,ledgerEpoch:profile.ledgerEpoch,deviceInstanceId:profile.deviceInstanceId,expiresAt:now+30000,mode:'RUN'};
    await tx.executeSql('INSERT INTO EvaluationDispatch (id,groupId,holderInstanceId,deviceId,epoch,state,expiresAt,workJson) VALUES (?,?,?,?,?,?,?,?)',[permit.id,peer.groupId,peer.holderInstanceId,peer.deviceId,this.epoch,'CLAIMED',work.expiresAt,JSON.stringify(work)]);await this.save(tx,state);break;
   }
  });return {work} as EvaluationClaim;
 }
 async status(peer:CoordinatorPeer,id:string):Promise<Object>{let result:EvaluationStatus={cancel:true,settled:false};await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{const rows=await tx.querySql('SELECT state,expiresAt,epoch,workJson FROM EvaluationDispatch WHERE id=? AND groupId=? AND holderInstanceId=?',[id,peer.groupId,peer.holderInstanceId]);try{if(!rows.goToFirstRow())throw Error('EVALUATION_SCOPE');const work=JSON.parse(rows.getString(3)) as EvaluationWork,profile=await this.profile(tx,peer);result={cancel:rows.getLong(1)<=Date.now()||rows.getLong(2)!==this.epoch||profile?.ledgerEpoch!==work.ledgerEpoch||profile?.deviceInstanceId!==work.deviceInstanceId,settled:rows.getString(0)==='SETTLED'};}finally{rows.close();}});return result;}
 async report(peer:CoordinatorPeer,id:string,report:EvaluationReport):Promise<Object>{
  await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{
   const rows=await tx.querySql('SELECT workJson,resultJson FROM EvaluationDispatch WHERE id=? AND groupId=? AND holderInstanceId=?',[id,peer.groupId,peer.holderInstanceId]);let work:EvaluationWork;try{if(!rows.goToFirstRow())throw Error('EVALUATION_SCOPE');work=JSON.parse(rows.getString(0)) as EvaluationWork;const previous=rows.getString(1);if(previous){if(canonical(JSON.parse(previous) as Object)!==canonical(report))throw Error('EVALUATION_REPORT_CONFLICT');return;}}finally{rows.close();}
   const allowed=['settled','output','durationMs','permitId','domain','errorCode','interrupted','overheadMs','notRun'];
   if(!report||Object.keys(report).some(k=>!allowed.includes(k))||report.settled!==true||report.permitId!==id||report.domain!=='REAL'||!Number.isFinite(report.durationMs)||report.durationMs<0||typeof report.output!=='string'||report.output.length>Math.ceil(work.permit.maxOutputBytes/3)*4||report.notRun!==undefined&&(report.notRun!==true||report.durationMs!==0||report.output!==''||report.errorCode!==undefined||report.interrupted!==undefined)||report.interrupted!==undefined&&(report.interrupted!==true||report.output!==''||report.errorCode!==undefined)||report.errorCode!==undefined&&(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(report.errorCode)||report.output!=='')||report.overheadMs!==undefined&&(report.notRun||!Number.isFinite(report.overheadMs)||report.overheadMs<0||report.overheadMs>report.durationMs))throw Error('EVALUATION_REPORT_INVALID');
   const base64=new util.Base64Helper(),output=report.output.length===0?new Uint8Array(0):base64.decodeSync(report.output);if(output.length>work.permit.maxOutputBytes||(output.length===0?'':base64.encodeToStringSync(output))!==report.output)throw Error('EVALUATION_REPORT_INVALID');
   await tx.executeSql("UPDATE EvaluationDispatch SET state='SETTLED',resultJson=? WHERE id=?",[JSON.stringify(report),id]);
   const profile=await this.profile(tx,peer),executor=profile?.executors.find(e=>e.target.targetId===work.permit.targetId);if(!profile||!executor||profile.ledgerEpoch!==work.ledgerEpoch||profile.deviceInstanceId!==work.deviceInstanceId||coordinatorExecutorIdentity(executor)!==work.permit.identity||work.coordinatorEpoch!==this.epoch||work.expiresAt<Date.now())return;
   const state=await this.state(tx,peer,profile,executor),pack=this.pack(executor),test=pack?.cases[state.next];if(!pack||!test||test.id!==work.permit.caseId||pack.digest!==work.permit.packDigest)throw Error('EVALUATION_CASE_CHANGED');
   if(report.notRun||report.interrupted)return;
   let passed=false,score=0;
   if(test.expect.kind==='REJECT'){passed=report.errorCode===test.expect.errorCode;score=passed?1:0;}
   else if(!report.errorCode){score=await coordinatorReferenceScore(pack.manifest.contract.capability,test.input,test.expected!,output);passed=score>=pack.manifest.qualityThreshold;}
   state.admission.revision++;
   if(!passed){state.admission.state='SUSPENDED';state.admission.reasonCode='REFERENCE_OUTPUT_MISMATCH';}
   else{state.next++;if(!state.scores)state.scores=[];state.scores.push(score);if(!report.errorCode)state.durations.push(Math.max(0,report.durationMs-(report.overheadMs??0)));if(state.next===pack.cases.length){state.admission.state='ACTIVE';state.admission.reasonCode='REFERENCE_SUITE_PASSED';state.admission.quality={value:Math.min(...state.scores),source:'MEASURED',sampledAt:Date.now(),ttlMs:3600000,unit:'score'};}}
   await this.save(tx,state);
  });this.onChanged?.(peer.groupId,peer.holderInstanceId);return {acknowledged:true} as EvaluationAck;
 }
}
