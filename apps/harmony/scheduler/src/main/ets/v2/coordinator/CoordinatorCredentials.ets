import { relationalStore } from '@kit.ArkData';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';
import { CoordinatorDatabase, CoordinatorTransaction } from './CoordinatorDatabase';
import { hash, bytes } from '../platform/NativeTransport';
export interface CoordinatorPeer {groupId:string;holderInstanceId:string;deviceId:string;principalId:string;credentialId:string;}
export interface CoordinatorCredential {credential:string;peer:CoordinatorPeer;}
interface DeviceRegistration {installationId:string;}
interface DeviceBinding {deviceId?:string;}
interface CredentialMetadata {peer:CoordinatorPeer;domain:string;expiresAt:number;}
/** Device credentials share the Windows storage format. App credential hydration is a separate adapter. */
export class CoordinatorCredentials {
 private database:CoordinatorDatabase;
 private domain:string;
 constructor(database:CoordinatorDatabase,domain:string){if(!['REAL','SIMULATED'].includes(domain))throw Error('DOMAIN_INVALID');this.database=database;this.domain=domain;}
 async issueDevice(groupId:string,principalId:string,deviceId:string,holderInstanceId:string):Promise<CoordinatorCredential>{
  for(const id of [groupId,principalId,deviceId,holderInstanceId])if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id))throw Error('IDENTITY_INVALID');
  const random=cryptoFramework.createRandom().generateRandomSync(32).data;
  const credential=new util.Base64Helper().encodeToStringSync(random).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const peer:CoordinatorPeer={groupId,principalId,deviceId,holderInstanceId,credentialId:util.generateRandomUUID(true)};
  const metadata:CredentialMetadata={peer,domain:this.domain,expiresAt:Date.now()+30*86400000};
  await this.database.transaction(async(db:CoordinatorTransaction):Promise<void>=>{
   await db.executeSql('INSERT INTO Credential (id,groupId,holderInstanceId,tokenHash,revoked,revision,metadataJson) VALUES (?,?,?,?,0,1,?)',[peer.credentialId,groupId,holderInstanceId,hash(bytes(credential)),JSON.stringify(metadata)]);
  });
  return {credential,peer};
 }
 async authenticateDevice(credential:string):Promise<CoordinatorPeer>{
  if(!/^[A-Za-z0-9_-]{43}$/.test(credential))throw Error('CREDENTIAL_INVALID');
  let peer:CoordinatorPeer|null=null;
  await this.database.transaction(async(db:CoordinatorTransaction):Promise<void>=>{
   const rows=await db.querySql('SELECT revoked,metadataJson FROM Credential WHERE tokenHash=?',[hash(bytes(credential))]);
   let metadata:CredentialMetadata|null=null;
   try{if(!rows.goToFirstRow()||rows.getLong(0)!==0)throw Error('CREDENTIAL_REVOKED');metadata=JSON.parse(rows.getString(1)) as CredentialMetadata;}finally{rows.close();}
   if(metadata===null||metadata.domain!==this.domain||metadata.expiresAt<=Date.now())throw Error('CREDENTIAL_EXPIRED');
   // App credentials must never be accepted as owner/device authority.
   const installations=await db.querySql('SELECT id FROM RegisteredInstallation WHERE holderInstanceId=?',[metadata.peer.holderInstanceId]);
   try{if(installations.goToFirstRow())throw Error('DEVICE_OWNER_CREDENTIAL_REQUIRED');}finally{installations.close();}
   const registration=await db.querySql('SELECT metadataJson FROM Device WHERE id=?',[JSON.stringify(['space-device-installation',metadata.peer.deviceId])]);
   let installationId='';try{if(registration.goToFirstRow())installationId=(JSON.parse(registration.getString(0)) as DeviceRegistration).installationId;}finally{registration.close();}
   if(installationId){const binding=await db.querySql('SELECT metadataJson FROM Device WHERE id=?',[JSON.stringify(['space-installation',installationId])]);
    try{if(!binding.goToFirstRow()||(JSON.parse(binding.getString(0)) as DeviceBinding).deviceId!==metadata.peer.deviceId)throw Error('DEVICE_LEFT_SPACE');}finally{binding.close();}}
   peer=metadata.peer;
  });
  if(peer===null)throw Error('CREDENTIAL_INVALID');return peer;
 }
 async revoke(credentialId:string):Promise<void>{
  await this.database.transaction(async(db:CoordinatorTransaction):Promise<void>=>{await db.executeSql('UPDATE Credential SET revoked=1,revision=revision+1 WHERE id=?',[credentialId]);});
 }
}
