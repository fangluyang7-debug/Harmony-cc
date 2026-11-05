import { ExecutionConfigV2, ExecutorV2, protocolId, validExecutionConfigV2, validExecutorV2 } from '@harmony/scheduler-core';

/** Control plane carries identifiers and bounded reference outputs, never executable code or arbitrary input URLs. */
export interface EvaluationPermit {
  id:string;groupId:string;holderInstanceId:string;targetId:string;identity:string;packDigest:string;caseId:string;
  inputHash:string;config:ExecutionConfigV2;maxOutputBytes:number;timeoutMs:number;domain:'REAL'|'SIMULATED';
}
export interface EvaluationResult {errorCode?:string;interrupted?:true;overheadMs?:number;notRun?:true;settled:true;output:Buffer;durationMs:number;permitId:string;domain:'REAL'|'SIMULATED';}
export interface EvaluationWork {
  permit:EvaluationPermit;executor:ExecutorV2;coordinatorEpoch:number;ledgerEpoch:number;deviceInstanceId:string;
  expiresAt:number;mode:'RUN'|'RECONCILE';
}
export interface EvaluationReport {errorCode?:string;interrupted?:true;overheadMs?:number;notRun?:true;settled:true;output:string;durationMs:number;permitId:string;domain:'REAL'|'SIMULATED';}
export const evaluationOutputLimit=65536;
const keys=(v:object,names:string[])=>Object.keys(v).sort().join('|')===names.sort().join('|');
export function validEvaluationPermit(v:any):v is EvaluationPermit {
  return !!v&&keys(v,['id','groupId','holderInstanceId','targetId','identity','packDigest','caseId','inputHash','config','maxOutputBytes','timeoutMs','domain'])&&
    typeof v.id==='string'&&/^[a-f0-9-]{36}$/.test(v.id)&&[v.groupId,v.holderInstanceId,v.targetId,v.caseId].every(protocolId)&&
    [v.identity,v.packDigest,v.inputHash].every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x))&&validExecutionConfigV2(v.config)&&
    Number.isSafeInteger(v.maxOutputBytes)&&v.maxOutputBytes>0&&v.maxOutputBytes<=evaluationOutputLimit&&
    Number.isSafeInteger(v.timeoutMs)&&v.timeoutMs>0&&v.timeoutMs<=300000&&['REAL','SIMULATED'].includes(v.domain);
}
export function validEvaluationWork(v:any):v is EvaluationWork {
  return !!v&&keys(v,['permit','executor','coordinatorEpoch','ledgerEpoch','deviceInstanceId','expiresAt','mode'])&&
    validEvaluationPermit(v.permit)&&validExecutorV2(v.executor)&&v.executor.target.targetId===v.permit.targetId&&
    [v.coordinatorEpoch,v.ledgerEpoch,v.expiresAt].every(n=>Number.isSafeInteger(n)&&n>0)&&protocolId(v.deviceInstanceId)&&['RUN','RECONCILE'].includes(v.mode);
}
export function decodeEvaluationReport(v:any,permit:EvaluationPermit):EvaluationResult {
  if(!v||!keys(v,['settled','output','durationMs','permitId','domain',...(v.notRun===undefined?[]:['notRun']),...(v.errorCode===undefined?[]:['errorCode']),...(v.interrupted===undefined?[]:['interrupted']),...(v.overheadMs===undefined?[]:['overheadMs'])])||v.settled!==true||v.permitId!==permit.id||v.domain!==permit.domain||
    !Number.isFinite(v.durationMs)||v.durationMs<0||typeof v.output!=='string'||v.output.length>Math.ceil(permit.maxOutputBytes/3)*4)throw Error('EVALUATION_REPORT_INVALID');
  if(v.notRun!==undefined&&(v.notRun!==true||v.output!==''||v.durationMs!==0))throw Error('EVALUATION_REPORT_INVALID');
  if(v.overheadMs!==undefined&&(v.notRun||!Number.isFinite(v.overheadMs)||v.overheadMs<0||v.overheadMs>v.durationMs))throw Error("EVALUATION_REPORT_INVALID");
  if(v.errorCode!==undefined&&(!protocolId(v.errorCode)||v.output!==''||v.notRun||v.interrupted))throw Error('EVALUATION_REPORT_INVALID');
  if(v.interrupted!==undefined&&(v.interrupted!==true||v.notRun||v.output!==''))throw Error('EVALUATION_REPORT_INVALID');
  const output=Buffer.from(v.output,'base64');
  if(output.length>permit.maxOutputBytes||output.toString('base64')!==v.output)throw Error('EVALUATION_REPORT_INVALID');
  return {...(v.errorCode?{errorCode:v.errorCode}:{}),...(v.interrupted?{interrupted:true as const}:{}),...(v.overheadMs!==undefined?{overheadMs:v.overheadMs}:{}),...(v.notRun===true?{notRun:true as const}:{}),settled:true,output,durationMs:v.durationMs,permitId:permit.id,domain:permit.domain};
}
