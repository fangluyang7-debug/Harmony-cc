import { common } from '@kit.AbilityKit';
import { relationalStore } from '@kit.ArkData';
import { hash } from './NativeTransport';
/** One App sandbox owns this bounded cache. SQL commits publish complete inputs atomically. */
export class NativeInputStore {
 private static opening:Promise<NativeInputStore>|null=null;
 private db:relationalStore.RdbStore;
 private work:Promise<void>=Promise.resolve();
 private constructor(db:relationalStore.RdbStore){this.db=db;}
 static open(context:common.UIAbilityContext):Promise<NativeInputStore>{
  if(NativeInputStore.opening===null)NativeInputStore.opening=NativeInputStore.create(context).catch((error:Error)=>{NativeInputStore.opening=null;throw error;});return NativeInputStore.opening;
 }
 private static async create(context:common.UIAbilityContext):Promise<NativeInputStore>{
  const db=await relationalStore.getRdbStore(context,{name:'scheduler-inputs-v2.db',securityLevel:relationalStore.SecurityLevel.S1});
  await db.executeSql('PRAGMA synchronous=FULL');
  await db.executeSql('CREATE TABLE IF NOT EXISTS inputs (hash TEXT PRIMARY KEY, data BLOB NOT NULL)');
  return new NativeInputStore(db);
 }
 private valid(contentHash:string):void{if(!/^[a-f0-9]{64}$/.test(contentHash))throw Error('INPUT_HASH');}
 async stage(contentHash:string,length:number,data:Uint8Array):Promise<void>{
  this.valid(contentHash);const copy=new Uint8Array(data);
  if(length<1||length>8388608||copy.byteLength!==length||hash(copy)!==contentHash)throw Error('INPUT_HASH');
  const operation=this.work.then(async()=>{
   this.db.beginTransaction();
   try{
    const existing=await this.read(contentHash);
    if(existing!==null){if(existing.byteLength!==length)throw Error('INPUT_HASH');this.db.commit();return;}
    const rows=await this.db.querySql('SELECT COALESCE(SUM(length(data)),0) AS used FROM inputs');let used=0;
    try{if(rows.goToFirstRow())used=rows.getLong(0);}finally{rows.close();}
    if(used+length>67108864)throw Error('SDK_INPUT_CACHE_FULL');
    await this.db.executeSql('INSERT INTO inputs (hash,data) VALUES (?,?)',[contentHash,copy]);this.db.commit();
   }catch(error){this.db.rollBack();throw error as Error;}
  });
  this.work=operation.catch(()=>{});await operation;
 }
 async read(contentHash:string):Promise<Uint8Array|null>{
  this.valid(contentHash);const rows=await this.db.querySql('SELECT data FROM inputs WHERE hash=?',[contentHash]);
  try{if(!rows.goToFirstRow())return null;const data=rows.getBlob(0);if(hash(data)!==contentHash)throw Error('INPUT_HASH');return data;}finally{rows.close();}
 }
}
