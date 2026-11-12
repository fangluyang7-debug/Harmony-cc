import { relationalStore } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { coordinatorMigrations } from './CoordinatorSchema';

export class CoordinatorTransaction {
 private native:relationalStore.Transaction;
 constructor(native:relationalStore.Transaction){this.native=native;}
 async executeSql(sql:string,args:relationalStore.ValueType[]=[]):Promise<void>{await this.native.execute(sql,args);}
 querySql(sql:string,args:relationalStore.ValueType[]=[]):Promise<relationalStore.ResultSet>{return this.native.querySql(sql,args);}
}
export interface CoordinatorOverviewRow {id:string;title:string;detail:string;state:string;}
export interface CoordinatorOverview {spaces:CoordinatorOverviewRow[];devices:CoordinatorOverviewRow[];tasks:CoordinatorOverviewRow[];apps:CoordinatorOverviewRow[];}
/** Native persistence for the coordinator, separate from the execution-host ledger. */
export class CoordinatorDatabase {
 private tail:Promise<void>=Promise.resolve();
 private store:relationalStore.RdbStore;
 private constructor(store:relationalStore.RdbStore){this.store=store;}
 static async open(context:common.UIAbilityContext):Promise<CoordinatorDatabase>{
  const store=await relationalStore.getRdbStore(context,{name:'harmony-coordinator.db',securityLevel:relationalStore.SecurityLevel.S1});
  const database=new CoordinatorDatabase(store);
  await store.executeSql('PRAGMA synchronous=FULL');
  await store.executeSql('CREATE TABLE IF NOT EXISTS NativeCoordinatorMigration (id TEXT PRIMARY KEY NOT NULL, digest TEXT NOT NULL)');
  await database.transaction(async(db:CoordinatorTransaction):Promise<void>=>{
   for(const migration of coordinatorMigrations){
    const rows=await db.querySql('SELECT digest FROM NativeCoordinatorMigration WHERE id=?',[migration.id]);
    let installed:string|null=null;
    try{if(rows.goToFirstRow())installed=rows.getString(0);}finally{rows.close();}
    if(installed!==null){if(installed!==migration.digest)throw Error('COORDINATOR_MIGRATION_CHANGED');continue;}
    for(const statement of migration.statements)await db.executeSql(statement);
    await db.executeSql('INSERT INTO NativeCoordinatorMigration (id,digest) VALUES (?,?)',[migration.id,migration.digest]);
   }
  });
  return database;
 }
 /** Serialize transactions so asynchronous callers cannot interleave begin/commit. */
 transaction(work:(db:CoordinatorTransaction)=>Promise<void>):Promise<void>{
  const run=this.tail.then(async():Promise<void>=>{
   const transaction=await this.store.createTransaction();
   try{await work(new CoordinatorTransaction(transaction));await transaction.commit();}catch(e){await transaction.rollback();throw e as Error;}
  });
  this.tail=run.catch(()=>{});return run;
 }
 async overview():Promise<CoordinatorOverview>{
  const result:CoordinatorOverview={spaces:[],devices:[],tasks:[],apps:[]};
  await this.transaction(async(db:CoordinatorTransaction):Promise<void>=>{
   const spaces=await db.querySql('SELECT id,name FROM TeamSpace ORDER BY createdAt DESC');
   try{while(spaces.goToNextRow())result.spaces.push({id:spaces.getString(0),title:spaces.getString(1),detail:spaces.getString(0),state:'已保存'});}finally{spaces.close();}
   const devices=await db.querySql('SELECT id,name,spaceId FROM SpaceDevice ORDER BY createdAt DESC');
   try{while(devices.goToNextRow())result.devices.push({id:devices.getString(0),title:devices.getString(1),detail:'空间 '+devices.getString(2),state:'在线状态待接入'});}finally{devices.close();}
   const tasks=await db.querySql('SELECT id,workflowId,state,holderInstanceId FROM Attempt ORDER BY rowid DESC LIMIT 100');
   try{while(tasks.goToNextRow())result.tasks.push({id:tasks.getString(0),title:tasks.getString(1),detail:'宿主 '+tasks.getString(3),state:tasks.getString(2)});}finally{tasks.close();}
   const apps=await db.querySql('SELECT i.id,a.label,i.state,i.deviceId FROM RegisteredInstallation i JOIN RegisteredApp a ON a.id=i.appId ORDER BY i.rowid DESC');
   try{while(apps.goToNextRow())result.apps.push({id:apps.getString(0),title:apps.getString(1),detail:'设备 '+apps.getString(3),state:apps.getString(2)});}finally{apps.close();}
  });return result;
 }
 async startEpoch(coordinatorId:string):Promise<number>{
  if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(coordinatorId))throw Error('COORDINATOR_ID_INVALID');
  let epoch=0;
  await this.transaction(async(db:CoordinatorTransaction):Promise<void>=>{
   await db.executeSql('INSERT OR IGNORE INTO CoordinatorState (id,epoch) VALUES (?,0)',[coordinatorId]);
   await db.executeSql('UPDATE CoordinatorState SET epoch=epoch+1 WHERE id=?',[coordinatorId]);
   const rows=await db.querySql('SELECT epoch FROM CoordinatorState WHERE id=?',[coordinatorId]);
   try{if(!rows.goToFirstRow())throw Error('COORDINATOR_EPOCH_MISSING');epoch=rows.getLong(0);}finally{rows.close();}
   if(!Number.isSafeInteger(epoch)||epoch<1)throw Error('COORDINATOR_EPOCH_INVALID');
  });
  return epoch;
 }
}
