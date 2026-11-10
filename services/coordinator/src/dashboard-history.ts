import {PrismaClient,CpuJob,TraceSpan,TransferAuthorization} from '../generated/client';

// Filter JSON in SQLite before returning large historical records to the event loop.
// All projections retain their group boundary; this does not prune execution evidence.
export function recentJobs(db:PrismaClient,groupId:string){
  return db.$queryRaw<CpuJob[]>`SELECT * FROM CpuJob WHERE groupId = ${groupId}
    ORDER BY CASE WHEN json_type(metadataJson, '$.request.now') IN ('integer','real')
      THEN json_extract(metadataJson, '$.request.now') ELSE 0 END DESC, id ASC LIMIT 100`;
}
export function traceRows(db:PrismaClient,groupId:string,traceId:string){
  return db.$queryRaw<TraceSpan[]>`SELECT * FROM TraceSpan WHERE groupId = ${groupId}
    AND json_extract(metadataJson, '$.span.traceId') = ${traceId}`;
}
export function attemptTraceRows(db:PrismaClient,groupId:string,attemptIds:string[]){
  if(!attemptIds.length)return Promise.resolve([] as TraceSpan[]);
  return db.$queryRaw<TraceSpan[]>`SELECT * FROM TraceSpan WHERE groupId = ${groupId}
    AND json_extract(metadataJson, '$.span.attemptId') IN (SELECT value FROM json_each(${JSON.stringify(attemptIds)}))`;
}
export function traceJobs(db:PrismaClient,groupId:string,traceId:string){
  return db.$queryRaw<CpuJob[]>`SELECT * FROM CpuJob WHERE groupId = ${groupId}
    AND json_extract(metadataJson, '$.traceId') = ${traceId}`;
}
export function recentTransfers(db:PrismaClient,groupId:string){
  return db.$queryRaw<TransferAuthorization[]>`SELECT * FROM TransferAuthorization WHERE groupId = ${groupId}
    ORDER BY json_extract(metadataJson, '$.authorization.issuedAt') DESC, id ASC LIMIT 100`;
}
