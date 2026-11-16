import {Prisma} from '../generated/client';
import {TaskInstanceV2} from '@harmony/scheduler-core';
const key=(id:string)=>JSON.stringify(['unadmitted-closure',id]);
type Attempt={id:string;groupId:string;holderInstanceId:string;state:string;recordJson:string|null};
/** Retirement is not an execution receipt: retain a separate audit marker. */
export async function unadmittedClosed(tx:Prisma.TransactionClient,row:Attempt):Promise<boolean>{
 if(row.recordJson!==null||row.state!=='CANCELLED')return false;
 const saved=await tx.device.findUnique({where:{id:key(row.id)}});if(!saved||saved.groupId!==row.groupId)return false;
 const proof=JSON.parse(saved.metadataJson);
 return proof.reason==='RETIRED_EPOCH_WITHOUT_ADMISSION'&&proof.holderInstanceId===row.holderInstanceId;
}
export async function attemptSettled(tx:Prisma.TransactionClient,row:Attempt):Promise<boolean>{
 if(row.state==='REJECTED')return true;
 if(row.recordJson!==null)return JSON.parse(row.recordJson).resourcesSettled===true;
 return unadmittedClosed(tx,row);
}
/** Missing holder evidence + no admission + a retired epoch; never expiry alone. */
export async function closeRetiredUnadmitted(tx:Prisma.TransactionClient,epoch:number,attemptId?:string):Promise<void>{
 const rows=await tx.attempt.findMany({where:{state:'HOLDER_RECORD_MISSING',recordJson:null,...(attemptId?{id:attemptId}:{})}});
 for(const row of rows){
  const task=JSON.parse(row.taskJson) as TaskInstanceV2;
  if(task.groupId!==row.groupId||task.contract?.sideEffectPolicy!=='PURE'||!Number.isSafeInteger(task.coordinatorEpoch)||task.coordinatorEpoch>=epoch||await tx.receipt.findUnique({where:{id:row.id}}))continue;
  const proof={reason:'RETIRED_EPOCH_WITHOUT_ADMISSION',previousState:row.state,holderInstanceId:row.holderInstanceId,epoch,closedAt:Date.now()};
  await tx.outbox.updateMany({where:{attemptId:row.id,acked:false},data:{superseded:true}});
  await tx.attempt.update({where:{id:row.id},data:{state:'CANCELLED'}});
  await tx.device.upsert({where:{id:key(row.id)},create:{id:key(row.id),groupId:row.groupId,revision:1,metadataJson:JSON.stringify(proof)},update:{revision:{increment:1},metadataJson:JSON.stringify(proof)}});
  // Do not overwrite another attempt's node state (e.g. a successful backup).
  await tx.node.updateMany({where:{currentAttemptId:row.id,winnerAttemptId:null,backupAttemptId:null},data:{state:'CANCELLED'}});
 }
}
