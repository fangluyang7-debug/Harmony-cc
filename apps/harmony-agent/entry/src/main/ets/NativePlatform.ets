import { util } from '@kit.ArkTS';
import { relationalStore } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { AgentPersistenceV2, AgentMessageFactoryV2, TrustedCoordinator, hash, bytes } from 'scheduler';
export { NativeTransport, bytes, text, hash, hashBytes, base64, hex, monotonic } from 'scheduler';
export const factory:AgentMessageFactoryV2={id:()=>util.generateRandomUUID(true),digest:(value:string)=>hash(bytes(value))};
export interface Peer {groupId:string;deviceId:string;holderInstanceId:string;principalId:string;credentialId:string;}
export interface Paired {credential:string;peer:Peer;}
export interface Invitation extends TrustedCoordinator {version:number;inviteId:string;groupId:string;address:string;certificate:string;fingerprint:string;code:string;expiresAt:number;tlsMode?:string;}
export interface Contribution {ownerMode:string;maxCpuThreads:number;maxMemoryBytes:number;reserveMemoryBytes:number;}
export interface Bootstrap {invitation:Invitation;holderInstanceId:string;domain:string;contribution:Contribution;}
export interface Installation {bootstrap:Bootstrap;paired:Paired;}
export class NativeDatabase {
 private db:relationalStore.RdbStore;
 private static active:NativeDatabase|null=null;
 private constructor(db:relationalStore.RdbStore){this.db=db;}
 static async open(context:common.UIAbilityContext):Promise<NativeDatabase>{
  if(NativeDatabase.active!==null)return NativeDatabase.active;
  const db=await relationalStore.getRdbStore(context,{name:'harmony-agent-v2.db',securityLevel:relationalStore.SecurityLevel.S1});
  await db.executeSql('PRAGMA synchronous=FULL');
  await db.executeSql('CREATE TABLE IF NOT EXISTS installation (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  NativeDatabase.active=new NativeDatabase(db);return NativeDatabase.active;
 }
 async get(key:string):Promise<string|null>{const rows=await this.db.querySql('SELECT value FROM installation WHERE id=?',[key]);try{return rows.goToFirstRow()?rows.getString(0):null;}finally{rows.close();}}
 async put(key:string,value:string):Promise<void>{await this.db.executeSql('INSERT OR REPLACE INTO installation (id,value) VALUES (?,?)',[key,value]);}
 ledger():AgentPersistenceV2 {return {load:()=>this.get('ledger'),commit:(value:string)=>this.put('ledger',value)};}
}
