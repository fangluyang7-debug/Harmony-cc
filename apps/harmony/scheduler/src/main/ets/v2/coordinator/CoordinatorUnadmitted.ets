import { CoordinatorTransaction } from './CoordinatorDatabase';
interface RecoveryClosure {reason:string;previousState:string;closedAt:number;epoch:number;}
interface RecoveryContract {sideEffectPolicy:string;}
interface RecoveryTask {coordinatorEpoch:number;groupId:string;contract:RecoveryContract;}
interface RecoveryOffer {task:RecoveryTask;}
interface RecoveryJob {state:string;holder:string;offer:RecoveryOffer|null;recoveryClosure?:RecoveryClosure;}
interface PendingMissing {id:string;group:string;holder:string;job:RecoveryJob;}
interface ResourceRecord {resourcesSettled?:boolean;}

/** A negative holder reply is not a receipt. Only retire an unadmitted PURE offer
 * from an older epoch, whose execution authorization can no longer succeed.
 * HOLDER_RECORD_MISSING is persisted exclusively by the authenticated status-reply handler. */
export async function closeRetiredUnadmitted(tx:CoordinatorTransaction,epoch:number):Promise<void>{
 const rows=await tx.querySql("SELECT a.id,a.groupId,a.holderInstanceId,j.metadataJson FROM Attempt a JOIN CpuJob j ON j.id=a.id AND j.groupId=a.groupId WHERE a.state='HOLDER_RECORD_MISSING' AND a.recordJson IS NULL AND NOT EXISTS (SELECT 1 FROM Receipt r WHERE r.attemptId=a.id)");
 const candidates:PendingMissing[]=[];
 try{while(rows.goToNextRow())candidates.push({id:rows.getString(0),group:rows.getString(1),holder:rows.getString(2),job:JSON.parse(rows.getString(3)) as RecoveryJob});}finally{rows.close();}
 for(const candidate of candidates){
  const job=candidate.job,task=job.offer?.task;
  if(job.state!=='HOLDER_RECORD_MISSING'||job.holder!==candidate.holder||!task||task.groupId!==candidate.group||task.contract.sideEffectPolicy!=='PURE'||!Number.isSafeInteger(task.coordinatorEpoch)||task.coordinatorEpoch>=epoch)continue;
  job.recoveryClosure={reason:'RETIRED_EPOCH_WITHOUT_ADMISSION',previousState:job.state,closedAt:Date.now(),epoch};job.state='CANCELLED';
  await tx.executeSql('UPDATE Outbox SET superseded=1 WHERE attemptId=? AND acked=0',[candidate.id]);
  await tx.executeSql("UPDATE Attempt SET state='CANCELLED' WHERE id=?",[candidate.id]);
  await tx.executeSql("UPDATE CpuJob SET state='CANCELLED',metadataJson=? WHERE id=?",[JSON.stringify(job),candidate.id]);
  await tx.executeSql("UPDATE Node SET state='CANCELLED' WHERE currentAttemptId=?",[candidate.id]);
  await tx.executeSql("UPDATE Workflow SET state='CANCELLED' WHERE id=?",[candidate.id]);
 }
}

function closed(state:string,record:string|null,jobState:string,jobRaw:string|null):boolean{
 // A real admission always wins over a no-admission closure marker.
 if(record!==null)return (JSON.parse(record) as ResourceRecord).resourcesSettled===true||state==='REJECTED';
 if(state==='REJECTED')return true;
 if(jobState!=='CANCELLED')return false;
 if(state==='')return true; // cancelled before an Attempt existed (Windows parity)
 const job:RecoveryJob|null=jobRaw===null?null:JSON.parse(jobRaw) as RecoveryJob;
 return state==='CANCELLED'&&job?.recoveryClosure?.reason==='RETIRED_EPOCH_WITHOUT_ADMISSION';
}

/** Shared by leaving and pairing; terminal history alone never proves settlement. */
export async function assertCoordinatorDeviceSettled(tx:CoordinatorTransaction,deviceId:string,groupId:string,holderId:string):Promise<void>{
 const reserved=await tx.querySql('SELECT a.state,a.recordJson,j.state,j.metadataJson FROM AppJobReservation r JOIN RegisteredInstallation i ON i.id=r.appInstanceId LEFT JOIN Attempt a ON a.id=r.id AND a.groupId=r.groupId LEFT JOIN CpuJob j ON j.id=r.id AND j.groupId=r.groupId AND j.principalId=r.principalId WHERE i.deviceId=? AND i.groupId=?',[deviceId,groupId]);
 try{while(reserved.goToNextRow())if(!closed(reserved.getString(0),reserved.isColumnNull(1)?null:reserved.getString(1),reserved.getString(2),reserved.isColumnNull(3)?null:reserved.getString(3)))throw Error('SPACE_SWITCH_BUSY');}finally{reserved.close();}
 const pending=await tx.querySql('SELECT a.state,a.recordJson,j.state,j.metadataJson FROM Attempt a LEFT JOIN CpuJob j ON j.id=a.id AND j.groupId=a.groupId WHERE a.groupId=? AND (a.holderInstanceId=? OR a.holderInstanceId IN (SELECT holderInstanceId FROM RegisteredInstallation WHERE deviceId=? AND groupId=?))',[groupId,holderId,deviceId,groupId]);
 try{while(pending.goToNextRow())if(!closed(pending.getString(0),pending.isColumnNull(1)?null:pending.getString(1),pending.getString(2),pending.isColumnNull(3)?null:pending.getString(3)))throw Error('SPACE_SWITCH_BUSY');}finally{pending.close();}
}
