import {AsyncLocalStorage} from 'node:async_hooks';
import {PrismaClient} from '../generated/client';

/** SQLite has one writer. Queue transaction entry AND standalone mutations in JS,
 * so implicit writes cannot occupy Prisma engine threads waiting for an active
 * interactive transaction to commit. Reads retain their normal concurrency.
 * https://github.com/prisma/orm/issues/29870 */
export function serializeSqliteTransactions(client:PrismaClient):PrismaClient {
 const inside=new AsyncLocalStorage<{active:boolean}>();let tail=Promise.resolve();
 const enqueue=<T>(work:()=>Promise<T>):Promise<T>=>{const run=tail.then(work);tail=run.then(()=>{},()=>{});return run;};
 const writes=new Set(['create','createMany','createManyAndReturn','update','updateMany','updateManyAndReturn','upsert','delete','deleteMany','$executeRaw','$executeRawUnsafe']);
 const db=client.$extends({query:{$allOperations({operation,args,query}){
  if(inside.getStore()?.active||!writes.has(operation))return query(args);
  return enqueue(()=>query(args));
 }}}) as unknown as PrismaClient;
 const transaction=db.$transaction.bind(db) as (...args:any[])=>Promise<any>;
 db.$transaction=((operation:any,options?:any)=>{
  if(inside.getStore()?.active)return Promise.reject(Error('SQLITE_NESTED_TRANSACTION'));
  return enqueue(()=>{const scope={active:true};return inside.run(scope,async()=>{
   try{return await transaction(operation,options);}finally{scope.active=false;}
  });});
 }) as typeof db.$transaction;
 return db;
}
