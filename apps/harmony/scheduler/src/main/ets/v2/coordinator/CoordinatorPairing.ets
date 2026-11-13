import { relationalStore } from '@kit.ArkData';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';
import { CoordinatorDatabase, CoordinatorTransaction } from './CoordinatorDatabase';
import { CoordinatorCertificate } from './CoordinatorCertificate';
import { CoordinatorCredential, CoordinatorPeer } from './CoordinatorCredentials';
import { hash, bytes } from '../platform/NativeTransport';
import { registerCoordinatorMembership, activateCoordinatorMembership } from './CoordinatorMembership';
interface InviteData {secretHash:string;expiresAt:number;used:boolean;principalId:string;deviceId:string;domain:string;rejoinInstallationId?:string;rejoinHolderId?:string;}
interface CredentialData {peer:CoordinatorPeer;domain:string;expiresAt:number;}
interface ShortCode {inviteId:string;code:string;expiresAt:number;}
interface CodeAttempt {count:number;expiresAt:number;}
interface Contribution {ownerMode:string;maxCpuThreads:number;maxMemoryBytes:number;reserveMemoryBytes:number;}
export interface NativeCoordinatorBootstrap {invitation:NativeCoordinatorInvitation;holderInstanceId:string;domain:string;contribution:Contribution;}
export interface NativePairingCode {pairingCode:string;pairingCodeExpiresAt:number;}
export interface NativePairRequest {inviteId:string;code:string;holderInstanceId:string;installationId?:string;previousDeviceId?:string;knownDeviceIds?:string[];}
export interface NativeCoordinatorInvitation {version:number;inviteId:string;code:string;address:string;certificate:string;fingerprint:string;expiresAt:number;groupId:string;tlsMode?:string;}
function secret(size:number):string{return new util.Base64Helper().encodeToStringSync(cryptoFramework.createRandom().generateRandomSync(size).data).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function validId(id:string):boolean{return typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id);}
/** Invitation exchange persists consumption and credential issuance in one transaction. */
export class CoordinatorPairing {
 private database:CoordinatorDatabase;
 private identity:CoordinatorCertificate;
 private domain:string;
 private shortCodes:Map<string,ShortCode>=new Map();
 private codeAttempts:Map<string,CodeAttempt>=new Map();
 private revocations:Set<(id:string)=>void>=new Set();
 onRevoked(listener:(id:string)=>void):()=>void{this.revocations.add(listener);return ()=>{this.revocations.delete(listener);};}
 constructor(database:CoordinatorDatabase,identity:CoordinatorCertificate,domain:string){if(!['REAL','SIMULATED'].includes(domain))throw Error('DOMAIN_INVALID');this.database=database;this.identity=identity;this.domain=domain;}
 issuePairingCode(invitation:NativeCoordinatorInvitation):NativePairingCode{
  const now=Date.now();for(const entry of this.shortCodes.entries())if(entry[1].expiresAt<=now)this.shortCodes.delete(entry[0]);
  if(this.shortCodes.size>=1000)throw Error('PAIRING_BUSY');
  let code='';
  do{const random=cryptoFramework.createRandom().generateRandomSync(4).data;const value=new DataView(random.buffer,random.byteOffset,4).getUint32(0);if(value>=4294000000)continue;code=String(value%1000000).padStart(6,'0');}while(!code||this.shortCodes.has(code));
  const expiresAt=Math.min(invitation.expiresAt,now+300000);this.shortCodes.set(code,{inviteId:invitation.inviteId,code:invitation.code,expiresAt});return {pairingCode:code,pairingCodeExpiresAt:expiresAt};
 }
 async redeemPairingCode(code:string,address:string,remote:string):Promise<NativeCoordinatorBootstrap>{
  const now=Date.now();for(const entry of this.codeAttempts.entries())if(entry[1].expiresAt<=now)this.codeAttempts.delete(entry[0]);
  if(this.codeAttempts.size>=2048&&!this.codeAttempts.has(remote))throw Error('PAIRING_REJECTED');
  for(const key of ['global',remote]){const attempt=this.codeAttempts.get(key)??{count:0,expiresAt:now+300000};if(attempt.count>=(key==='global'?100:5))throw Error('PAIRING_RATE_LIMITED');attempt.count++;this.codeAttempts.set(key,attempt);}
  if(typeof code!=='string'||!/^\d{6}$/.test(code))throw Error('PAIRING_REJECTED');const value=this.shortCodes.get(code);if(!value||value.expiresAt<=now)throw Error('PAIRING_REJECTED');
  const result=await this.readDeviceInvite(value.inviteId,value.code,address);this.codeAttempts.delete(remote);return result;
 }
 async readDeviceInvite(inviteId:string,code:string,address:string):Promise<NativeCoordinatorBootstrap>{
  if(!validId(inviteId)||!/^[A-Za-z0-9_-]{24}$/.test(code)||!/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(address))throw Error('INVITE_INVALID');
  let bootstrap:NativeCoordinatorBootstrap|null=null;
  await this.database.transaction(async(db:CoordinatorTransaction):Promise<void>=>{
   const row=await db.querySql('SELECT groupId,metadataJson FROM Invite WHERE id=?',[inviteId]);let groupId='',data:InviteData|null=null;
   try{if(!row.goToFirstRow())throw Error('INVITE_INVALID');groupId=row.getString(0);data=JSON.parse(row.getString(1)) as InviteData;}finally{row.close();}
   if(data===null||(data.used&&!data.rejoinInstallationId)||data.expiresAt<=Date.now()||data.domain!==this.domain||data.secretHash!==hash(bytes(code)))throw Error('INVITE_INVALID');
   const device=await db.querySql('SELECT spaceId,userId,holderId,settingsJson FROM SpaceDevice WHERE id=?',[data.deviceId]);
   try{if(!device.goToFirstRow()||device.getString(0)!==groupId||device.getString(1)!==data.principalId)throw Error('INVITE_INVALID');
    bootstrap={invitation:{version:2,inviteId,code,address,certificate:this.identity.certificate,fingerprint:this.identity.fingerprint,expiresAt:data.expiresAt,groupId,tlsMode:'pinned'},holderInstanceId:device.getString(2),domain:this.domain,contribution:JSON.parse(device.getString(3)) as Contribution};
   }finally{device.close();}
  });if(bootstrap===null)throw Error('INVITE_INVALID');return bootstrap;
 }
 async invite(groupId:string,principalId:string,deviceId:string,address:string):Promise<NativeCoordinatorInvitation>{
  if(![groupId,principalId,deviceId].every(validId)||!/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(address))throw Error('INVITE_INVALID');
  const inviteId=util.generateRandomUUID(true),code=secret(18),expiresAt=Date.now()+300000;
  const data:InviteData={secretHash:hash(bytes(code)),expiresAt,used:false,principalId,deviceId,domain:this.domain};
  await this.database.transaction(async(db:CoordinatorTransaction):Promise<void>=>{await db.executeSql('INSERT INTO Invite (id,groupId,revision,metadataJson) VALUES (?,?,1,?)',[inviteId,groupId,JSON.stringify(data)]);});
  return {version:2,inviteId,code,address,certificate:this.identity.certificate,fingerprint:this.identity.fingerprint,expiresAt,groupId};
 }
 async exchange(inviteId:string,code:string,holderInstanceId:string,installationId?:string,previousDeviceId?:string,knownDeviceIds:string[]=[]):Promise<CoordinatorCredential>{
  if(!validId(inviteId)||!validId(holderInstanceId)||typeof code!=='string'||!/^[A-Za-z0-9_-]{24}$/.test(code))throw Error('INVITE_INVALID');
  const credential=secret(32),credentialId=util.generateRandomUUID(true);let peer:CoordinatorPeer|null=null;let revoked:string[]=[];
  await this.database.transaction(async(db:CoordinatorTransaction):Promise<void>=>{
   const row=await db.querySql('SELECT groupId,metadataJson FROM Invite WHERE id=?',[inviteId]);let groupId='',data:InviteData|null=null;
   try{if(!row.goToFirstRow())throw Error('INVITE_INVALID');groupId=row.getString(0);data=JSON.parse(row.getString(1)) as InviteData;}finally{row.close();}
   if(data===null||data.expiresAt<=Date.now()||data.domain!==this.domain||data.secretHash!==hash(bytes(code)))throw Error('INVITE_INVALID');
   if(data.used&&(!data.rejoinInstallationId||data.rejoinInstallationId!==installationId||data.rejoinHolderId!==holderInstanceId))throw Error('INVITE_INVALID');
   const history=await db.querySql('SELECT revoked,metadataJson FROM Credential WHERE groupId=? AND holderInstanceId=?',[groupId,holderInstanceId]);
   try{while(history.goToNextRow()){const binding=JSON.parse(history.getString(1)) as CredentialData;if(binding.peer.deviceId!==data.deviceId||binding.peer.principalId!==data.principalId)throw Error('HOLDER_BINDING_CHANGED');if(history.getLong(0)===0)throw Error('HOLDER_ALREADY_REGISTERED');}}finally{history.close();}
   peer={groupId,holderInstanceId,deviceId:data.deviceId,principalId:data.principalId,credentialId};
   if(installationId){
    const device=await db.querySql('SELECT id FROM SpaceDevice WHERE id=?',[data.deviceId]);let exists=false;try{exists=device.goToFirstRow();}finally{device.close();}
    if(exists)await registerCoordinatorMembership(db,installationId,data.deviceId,previousDeviceId,data.principalId,knownDeviceIds);
   }
   revoked=await activateCoordinatorMembership(db,peer);
   const metadata:CredentialData={peer,domain:this.domain,expiresAt:Date.now()+30*86400000};data.used=true;if(installationId){data.rejoinInstallationId=installationId;data.rejoinHolderId=holderInstanceId;}
   await db.executeSql('UPDATE Invite SET revision=revision+1,metadataJson=? WHERE id=?',[JSON.stringify(data),inviteId]);
   await db.executeSql('INSERT INTO Credential (id,groupId,holderInstanceId,tokenHash,revoked,revision,metadataJson) VALUES (?,?,?,?,0,1,?)',[credentialId,groupId,holderInstanceId,hash(bytes(credential)),JSON.stringify(metadata)]);
  });
  if(peer===null)throw Error('INVITE_INVALID');for(const id of revoked)for(const listener of this.revocations)listener(id);return {credential,peer};
 }
 async leave(peer:CoordinatorPeer):Promise<void>{
  if(peer.app)throw Error('DEVICE_OWNER_REQUIRED');const revoked:string[]=[];
  await this.database.transaction(async(db:CoordinatorTransaction):Promise<void>=>{
   const pending=await db.querySql('SELECT state,recordJson FROM Attempt WHERE groupId=? AND (holderInstanceId=? OR holderInstanceId IN (SELECT holderInstanceId FROM RegisteredInstallation WHERE deviceId=? AND groupId=?))',[peer.groupId,peer.holderInstanceId,peer.deviceId,peer.groupId]);
   try{while(pending.goToNextRow())if(pending.getString(0)!=='REJECTED'&&(pending.isColumnNull(1)||(JSON.parse(pending.getString(1)) as Settlement).resourcesSettled!==true))throw Error('SPACE_SWITCH_BUSY');}finally{pending.close();}
   const reservations=await db.querySql('SELECT a.state,a.recordJson FROM AppJobReservation r JOIN RegisteredInstallation i ON i.id=r.appInstanceId LEFT JOIN Attempt a ON a.id=r.id WHERE i.deviceId=? AND i.groupId=?',[peer.deviceId,peer.groupId]);
   try{while(reservations.goToNextRow())if(reservations.getString(0)!=='REJECTED'&&(reservations.isColumnNull(1)||(JSON.parse(reservations.getString(1)) as Settlement).resourcesSettled!==true))throw Error('SPACE_SWITCH_BUSY');}finally{reservations.close();}
   const rows=await db.querySql('SELECT id,metadataJson FROM Credential WHERE groupId=? AND revoked=0',[peer.groupId]);
   try{while(rows.goToNextRow())if((JSON.parse(rows.getString(1)) as CredentialData).peer.deviceId===peer.deviceId)revoked.push(rows.getString(0));}finally{rows.close();}
   for(const id of revoked)await db.executeSql('UPDATE Credential SET revoked=1,revision=revision+1 WHERE id=?',[id]);
   await db.executeSql("UPDATE RegisteredInstallation SET state='REVOKED',secretHash=NULL WHERE deviceId=? AND groupId=?",[peer.deviceId,peer.groupId]);
   const registration=await db.querySql('SELECT metadataJson FROM Device WHERE id=?',[JSON.stringify(['space-device-installation',peer.deviceId])]);let installationId='';
   try{if(registration.goToFirstRow())installationId=(JSON.parse(registration.getString(0)) as DeviceInstallation).installationId;}finally{registration.close();}
   if(installationId)await db.executeSql('UPDATE Device SET revision=revision+1,metadataJson=? WHERE id=?',[JSON.stringify({left:true}),JSON.stringify(['space-installation',installationId])]);
  });
  for(const id of revoked)for(const listener of this.revocations)listener(id);
 }
}
interface Settlement {resourcesSettled?:boolean;}
interface DeviceInstallation {installationId:string;}
