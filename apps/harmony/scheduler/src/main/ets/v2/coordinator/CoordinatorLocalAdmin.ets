import { util } from '@kit.ArkTS';
import { CoordinatorDatabase, CoordinatorTransaction } from './CoordinatorDatabase';
import { CoordinatorPairing, NativeCoordinatorBootstrap, NativePairingCode } from './CoordinatorPairing';
export interface CoordinatorDeviceInvitation {bootstrap:NativeCoordinatorBootstrap;pairing:NativePairingCode;qrPayload:string;}
interface Resource {resourcePoolId:string;amount:number;}
interface Binding {groupId:string;holderInstanceId:string;appInstanceId:string|null;}
interface Budget {deviceId:string;capacity:Resource[];bindings:Binding[];}
interface Settings {ownerMode:string;maxCpuThreads:number;maxMemoryBytes:number;reserveMemoryBytes:number;capacityMode:string;}
/** In-process administration only. No remote unauthenticated administrative endpoint. */
export class CoordinatorLocalAdmin {
 private database:CoordinatorDatabase;
 private pairing:CoordinatorPairing;
 private principalId:string;
 private address:string;
 constructor(database:CoordinatorDatabase,pairing:CoordinatorPairing,principalId:string,address:string){this.database=database;this.pairing=pairing;this.principalId=principalId;this.address=address;}
 async ensureDefaultSpace():Promise<string>{
  let id='';const key='native-coordinator-default-space';
  await this.database.transaction(async(db:CoordinatorTransaction):Promise<void>=>{
   await db.executeSql('CREATE TABLE IF NOT EXISTS NativeCoordinatorSetting (id TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL)');
   const saved=await db.querySql('SELECT value FROM NativeCoordinatorSetting WHERE id=?',[key]);try{if(saved.goToFirstRow())id=saved.getString(0);}finally{saved.close();}
   if(id)return;
   // Preserve an existing locally owned room when upgrading an earlier HAP.
   const existing=await db.querySql('SELECT s.id FROM TeamSpace s JOIN SpaceMember m ON m.spaceId=s.id WHERE m.userId=? AND m.role=\'OWNER\' ORDER BY s.createdAt LIMIT 1',[this.principalId]);
   try{if(existing.goToFirstRow())id=existing.getString(0);}finally{existing.close();}
   if(!id){id=util.generateRandomUUID(true);await db.executeSql('INSERT INTO TeamSpace (id,name,createdAt) VALUES (?,\'本机协作空间\',?)',[id,Date.now()]);await db.executeSql('INSERT INTO SpaceMember (id,spaceId,userId,role,joinedAt) VALUES (?,?,?,\'OWNER\',?)',[util.generateRandomUUID(true),id,this.principalId,Date.now()]);}
   await db.executeSql('INSERT INTO NativeCoordinatorSetting (id,value) VALUES (?,?)',[key,id]);
  });return id;
 }
 async createSpace(name:string):Promise<string>{
  name=name.trim();if(!name||name.length>60)throw Error('INPUT_INVALID');const id=util.generateRandomUUID(true);
  await this.database.transaction(async(db:CoordinatorTransaction):Promise<void>=>{
   await db.executeSql('INSERT INTO TeamSpace (id,name,createdAt) VALUES (?,?,?)',[id,name,Date.now()]);
   await db.executeSql('INSERT INTO SpaceMember (id,spaceId,userId,role,joinedAt) VALUES (?,?,?,\'OWNER\',?)',[util.generateRandomUUID(true),id,this.principalId,Date.now()]);
  });return id;
 }
 async inviteDevice(spaceId:string,name:string):Promise<CoordinatorDeviceInvitation>{
  name=name.trim();if(!name||name.length>60)throw Error('INPUT_INVALID');
  const deviceId=util.generateRandomUUID(true),holderId=util.generateRandomUUID(true);
  // Bootstrap floor is replaced by coordinator policy as soon as measured hardware arrives.
  const settings:Settings={ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:67108864,reserveMemoryBytes:0,capacityMode:'auto'};
  const budget:Budget={deviceId,capacity:[{resourcePoolId:'cpu',amount:settings.maxCpuThreads},{resourcePoolId:'ram',amount:settings.maxMemoryBytes}],bindings:[{groupId:spaceId,holderInstanceId:holderId,appInstanceId:null}]};
  await this.database.transaction(async(db:CoordinatorTransaction):Promise<void>=>{
   const member=await db.querySql('SELECT role FROM SpaceMember WHERE spaceId=? AND userId=?',[spaceId,this.principalId]);
   try{if(!member.goToFirstRow()||!['OWNER','MEMBER'].includes(member.getString(0)))throw Error('SPACE_FORBIDDEN');}finally{member.close();}
   await db.executeSql('INSERT INTO SpaceDevice (id,spaceId,userId,holderId,name,settingsJson,createdAt) VALUES (?,?,?,?,?,?,?)',[deviceId,spaceId,this.principalId,holderId,name,JSON.stringify(settings),Date.now()]);
   await db.executeSql('INSERT INTO Device (id,groupId,revision,metadataJson) VALUES (?,\'physical-budget\',1,?)',[JSON.stringify(['budget',deviceId]),JSON.stringify(budget)]);
  });
  const invitation=await this.pairing.invite(spaceId,this.principalId,deviceId,this.address);
  return {bootstrap:await this.pairing.readDeviceInvite(invitation.inviteId,invitation.code,this.address),pairing:this.pairing.issuePairingCode(invitation),qrPayload:invitation.address+'/#device='+invitation.inviteId+'.'+invitation.code+'&pin='+invitation.fingerprint};
 }
}
