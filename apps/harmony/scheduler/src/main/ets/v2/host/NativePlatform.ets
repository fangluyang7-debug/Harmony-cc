import { util } from '@kit.ArkTS';
import { relationalStore } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { AgentPersistenceV2 } from '../agent/AgentStoreV2';
import { AgentMessageFactoryV2 } from '../agent/AgentJournalV2';
import { TrustedCoordinator, hash, bytes } from '../platform/NativeTransport';
export { NativeTransport, bytes, text, hash, hashBytes, base64, hex, monotonic } from '../platform/NativeTransport';
class NativeMessageFactory implements AgentMessageFactoryV2 {id():string{return util.generateRandomUUID(true);}digest(value:string):string{return hash(bytes(value));}}
export const factory:AgentMessageFactoryV2=new NativeMessageFactory();
export interface Peer {groupId:string;deviceId:string;holderInstanceId:string;principalId:string;credentialId:string;}
export interface Paired {credential:string;peer:Peer;}
export interface Invitation extends TrustedCoordinator {version:number;inviteId:string;groupId:string;address:string;certificate:string;fingerprint:string;code:string;expiresAt:number;tlsMode?:string;}
export interface Contribution {ownerMode:string;maxCpuThreads:number;maxMemoryBytes:number;reserveMemoryBytes:number;}
export interface Bootstrap {invitation:Invitation;holderInstanceId:string;domain:string;contribution:Contribution;}
export interface Installation {bootstrap:Bootstrap;paired:Paired;appInstanceId?:string;}
export class NativeDatabase {
 private db:relationalStore.RdbStore;
 private static active:NativeDatabase|null=null;
 private operations:Promise<void>=Promise.resolve();
 private constructor(db:relationalStore.RdbStore){this.db=db;}
 static async open(context:common.UIAbilityContext):Promise<NativeDatabase>{
  if(NativeDatabase.active!==null)return NativeDatabase.active;
  const db=await relationalStore.getRdbStore(context,{name:'harmony-agent-v2.db',securityLevel:relationalStore.SecurityLevel.S1});
  await db.executeSql('PRAGMA synchronous=FULL');
  await db.executeSql('CREATE TABLE IF NOT EXISTS installation (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  NativeDatabase.active=new NativeDatabase(db);return NativeDatabase.active;
 }
 get(key:string):Promise<string|null>{const run=this.operations.then(()=>this.readValue(key));this.operations=run.then(()=>{},()=>{});return run;}
 private async readValue(key:string):Promise<string|null>{
  // querySql uses a bounded shared-memory row window. A history > 2 MiB must
  // never look like a missing ledger and overwrite its execution fences.
  const sizes=await this.db.querySql('SELECT length(value) FROM installation WHERE id=?',[key]);let size=0;
  try{if(!sizes.goToFirstRow()){if(sizes.rowCount!==0)throw Error('DATABASE_CURSOR_UNAVAILABLE');return null;}size=sizes.getLong(0);}finally{sizes.close();}
  if(!Number.isSafeInteger(size)||size<0)throw Error('DATABASE_VALUE_LENGTH');
  const parts:string[]=[];
  for(let offset=1;offset<=size;offset+=131072){
   const rows=await this.db.querySql('SELECT substr(value,?,131072) FROM installation WHERE id=?',[offset,key]);
   try{if(!rows.goToFirstRow())throw Error('DATABASE_VALUE_UNAVAILABLE');parts.push(rows.getString(0));}finally{rows.close();}
  }
  return parts.join('');
 }
 put(key:string,value:string):Promise<void>{const run=this.operations.then(()=>this.db.executeSql('INSERT OR REPLACE INTO installation (id,value) VALUES (?,?)',[key,value]));this.operations=run.catch(()=>{});return run;}
 delete(key:string):Promise<void>{const run=this.operations.then(()=>this.db.executeSql('DELETE FROM installation WHERE id=?',[key]));this.operations=run.catch(()=>{});return run;}
 async storedIdentities():Promise<string[]>{const rows=await this.db.querySql("SELECT value FROM installation WHERE id='identity' OR id LIKE 'identity:%'");const values:string[]=[];try{while(rows.goToNextRow())values.push(rows.getString(0));return values;}finally{rows.close();}}
 ledger(key:string='ledger'):AgentPersistenceV2 {return new NativeLedgerPersistence(this,key);}
}

class NativeLedgerPersistence implements AgentPersistenceV2 {
 private db:NativeDatabase;
 private key:string;
 constructor(db:NativeDatabase,key:string){this.db=db;this.key=key;}
 load():Promise<string|null>{return this.db.get(this.key);}
 commit(value:string):Promise<void>{return this.db.put(this.key,value);}
}
