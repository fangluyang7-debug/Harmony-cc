import { relationalStore } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { coordinatorMigrations } from './CoordinatorSchema';
import { DeviceProfileV2, sampleUsableV2, validDeviceProfileV2 } from '../protocol/ResourcesV2';
import { CapabilityAdmissionV2 } from '../protocol/ResourcesV2';
import { StoredAppActivity } from './CoordinatorActivity';

export class CoordinatorTransaction {
 private native:relationalStore.Transaction;
 constructor(native:relationalStore.Transaction){this.native=native;}
 async executeSql(sql:string,args:relationalStore.ValueType[]=[]):Promise<void>{await this.native.execute(sql,args);}
 querySql(sql:string,args:relationalStore.ValueType[]=[]):Promise<relationalStore.ResultSet>{return this.native.querySql(sql,args);}
}
export interface CoordinatorOverviewRow {id:string;title:string;detail:string;state:string;profiles?:DeviceProfileV2[];activities?:StoredAppActivity[];qualifications?:CapabilityAdmissionV2[];}
interface NativeQualificationRow {admission:CapabilityAdmissionV2;}
export interface CoordinatorOverview {spaces:CoordinatorOverviewRow[];devices:CoordinatorOverviewRow[];tasks:CoordinatorOverviewRow[];apps:CoordinatorOverviewRow[];}
/** Native persistence for the coordinator, separate from the execution-host ledger. */
export class CoordinatorDatabase {
 /** The control transport supplies live session state; database rows are never presence. */
 controlState:((group:string,holder:string,instance:string,epoch:number)=>string)|null=null;
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
   const now=Date.now(),profiles:Map<string,DeviceProfileV2[]>=new Map();
   const holders=await db.querySql('SELECT id,groupId,metadataJson FROM DeviceInstance');
   try{while(holders.goToNextRow()){
    if(!holders.getString(0).startsWith('["profile",'))continue;
    try{
     const profile=JSON.parse(holders.getString(2)) as DeviceProfileV2,group=holders.getString(1);
     if(!validDeviceProfileV2(profile)||profile.domain!=='REAL'||
       this.controlState===null||this.controlState(group,profile.holderInstanceId,profile.deviceInstanceId,profile.ledgerEpoch)!=='ONLINE'||
       !sampleUsableV2(profile.ownerActivity,now,'REAL')||profile.ownerActivity.sampledAt+profile.ownerActivity.ttlMs<=now||
       !sampleUsableV2(profile.foreground,now,'REAL')||profile.foreground.sampledAt+profile.foreground.ttlMs<=now||profile.foreground.value!=='FOREGROUND')continue;
     const key=JSON.stringify([group,profile.deviceId]),list=profiles.get(key)??[];list.push(profile);profiles.set(key,list);
    }catch(e){continue;}
   }}finally{holders.close();}
   const devices=await db.querySql('SELECT id,name,spaceId FROM SpaceDevice WHERE EXISTS (SELECT 1 FROM Credential c WHERE c.groupId=SpaceDevice.spaceId AND c.holderInstanceId=SpaceDevice.holderId AND c.revoked=0) ORDER BY createdAt DESC');
   try{while(devices.goToNextRow()){
    const active=profiles.get(JSON.stringify([devices.getString(2),devices.getString(0)]))??[];
    result.devices.push({id:devices.getString(0),title:devices.getString(1),detail:active.length?String(active.length)+' 个在线宿主':'已配对，等待有效控制连接与资源画像',state:active.length?'在线':'已接入 · 待就绪',profiles:active});
   }}finally{devices.close();}
   const qualificationRows=await db.querySql('SELECT metadataJson FROM CapabilityState');
   try{while(qualificationRows.goToNextRow()){
    const value=JSON.parse(qualificationRows.getString(0)) as NativeQualificationRow;
    if(!value.admission)continue;
    const device=result.devices.find(d=>d.profiles?.some(p=>p.holderInstanceId===value.admission.holderInstanceId));
    if(device){if(!device.qualifications)device.qualifications=[];device.qualifications.push(value.admission);}
   }}finally{qualificationRows.close();}
   const activityRows=await db.querySql('SELECT id,metadataJson FROM Device WHERE id LIKE ?',['["app-activity",%']);
   try{while(activityRows.goToNextRow()){
    const value=JSON.parse(activityRows.getString(1)) as StoredAppActivity;
    const device=result.devices.find(d=>d.id===value.deviceId&&d.profiles?.some(p=>p.holderInstanceId===value.holderInstanceId));
    const fresh=now>=value.receivedAt&&now-value.receivedAt<=10000;
    if(device&&fresh){if(!device.activities)device.activities=[];device.activities.push(value);}
    for(const task of value.activity.tasks){
     result.tasks.push({id:value.holderInstanceId+':'+task.taskId,title:task.operation+' · '+task.taskId,
      detail:'应用观测 · '+task.phase+' · 设备 '+value.deviceId+' · '+Math.max(0,task.updatedAt-task.startedAt)+' ms'+(task.error?' · '+task.error:''),
      state:task.state==='RUNNING'&&(!fresh||!device)?'状态待更新':task.state});
    }
   }}finally{activityRows.close();}
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
