import { CoordinatorTransaction } from './CoordinatorDatabase';
import { CoordinatorPeer } from './CoordinatorCredentials';
interface Registration {installationId:string;}
interface Binding {deviceId:string;groupId:string;holderInstanceId:string;}
interface Device {id:string;spaceId:string;userId:string;holderId:string;}
interface RecordState {resourcesSettled?:boolean;}
interface CredentialMetadata {peer:CoordinatorPeer;}
const deviceKey=(id:string):string=>JSON.stringify(['space-device-installation',id]);
const installationKey=(id:string):string=>JSON.stringify(['space-installation',id]);
async function metadata(db:CoordinatorTransaction,id:string):Promise<string|null>{
 const rows=await db.querySql('SELECT metadataJson FROM Device WHERE id=?',[id]);
 try{return rows.goToFirstRow()?rows.getString(0):null;}finally{rows.close();}
}
async function device(db:CoordinatorTransaction,id:string):Promise<Device|null>{
 const rows=await db.querySql('SELECT id,spaceId,userId,holderId FROM SpaceDevice WHERE id=?',[id]);
 try{return rows.goToFirstRow()?{id:rows.getString(0),spaceId:rows.getString(1),userId:rows.getString(2),holderId:rows.getString(3)}:null;}finally{rows.close();}
}
async function register(db:CoordinatorTransaction,value:Device,installationId:string):Promise<void>{
 const id=deviceKey(value.id),existing=await metadata(db,id);
 if(existing!==null){if((JSON.parse(existing) as Registration).installationId!==installationId)throw Error('DEVICE_INSTALLATION_CONFLICT');return;}
 await db.executeSql('INSERT INTO Device (id,groupId,revision,metadataJson) VALUES (?,?,1,?)',[id,value.spaceId,JSON.stringify({installationId})]);
}
/** Same durable installation keys and switch fences as Windows device-membership.ts. */
export async function registerCoordinatorMembership(db:CoordinatorTransaction,installationId:string,deviceId:string,previousDeviceId:string|undefined,userId:string,knownDeviceIds:string[]):Promise<void>{
 if(!/^[a-f0-9-]{36}$/.test(installationId)||!Array.isArray(knownDeviceIds)||knownDeviceIds.length>200||knownDeviceIds.some(id=>typeof id!=='string'))throw Error('DEVICE_INSTALLATION_INVALID');
 const id=installationKey(installationId),binding=await metadata(db,id);
 const previous=binding===null&&previousDeviceId?await device(db,previousDeviceId):null;
 if(previous!==null){
  if(previous.userId!==userId)throw Error('DEVICE_FORBIDDEN');await register(db,previous,installationId);
  const value:Binding={deviceId:previous.id,groupId:previous.spaceId,holderInstanceId:previous.holderId};
  await db.executeSql('INSERT INTO Device (id,groupId,revision,metadataJson) VALUES (?,\'space-membership\',1,?)',[id,JSON.stringify(value)]);
 }
 for(const knownId of new Set<string>(knownDeviceIds)){
  if(knownId===deviceId)continue;const historical=await device(db,knownId);
  if(historical!==null&&historical.userId===userId)await register(db,historical,installationId);
 }
 const current=await device(db,deviceId);if(current===null)throw Error('DEVICE_NOT_FOUND');await register(db,current,installationId);
}
export async function activateCoordinatorMembership(db:CoordinatorTransaction,peer:CoordinatorPeer):Promise<string[]>{
 const row=await metadata(db,deviceKey(peer.deviceId));if(row===null)return [];
 const installationId=(JSON.parse(row) as Registration).installationId,linked:string[]=[],revoked:string[]=[];
 const registrations=await db.querySql('SELECT id,metadataJson FROM Device');
 try{while(registrations.goToNextRow()){const id=registrations.getString(0);if(id.startsWith('["space-device-installation",')&&(JSON.parse(registrations.getString(1)) as Registration).installationId===installationId)linked.push((JSON.parse(id) as string[])[1]);}}finally{registrations.close();}
 for(const oldId of linked){
  if(oldId===peer.deviceId)continue;const old=await device(db,oldId);if(old===null)continue;
  const reserved=await db.querySql('SELECT a.state,a.recordJson FROM AppJobReservation r JOIN RegisteredInstallation i ON i.id=r.appInstanceId LEFT JOIN Attempt a ON a.id=r.id WHERE i.deviceId=? AND i.groupId=?',[oldId,old.spaceId]);
  try{while(reserved.goToNextRow()){if(reserved.getString(0)==='REJECTED')continue;const record=reserved.isColumnNull(1)?null:JSON.parse(reserved.getString(1)) as RecordState;if(record?.resourcesSettled!==true)throw Error('SPACE_SWITCH_BUSY');}}finally{reserved.close();}
  const pending=await db.querySql('SELECT state,recordJson FROM Attempt WHERE groupId=? AND (holderInstanceId=? OR holderInstanceId IN (SELECT holderInstanceId FROM RegisteredInstallation WHERE deviceId=? AND groupId=?))',[old.spaceId,old.holderId,oldId,old.spaceId]);
  try{while(pending.goToNextRow()){if(pending.getString(0)==='REJECTED')continue;const record=pending.isColumnNull(1)?null:JSON.parse(pending.getString(1)) as RecordState;if(record?.resourcesSettled!==true)throw Error('SPACE_SWITCH_BUSY');}}finally{pending.close();}
  const credentials=await db.querySql('SELECT id,metadataJson FROM Credential WHERE groupId=? AND revoked=0',[old.spaceId]);const ids:string[]=[];
  try{while(credentials.goToNextRow())if((JSON.parse(credentials.getString(1)) as CredentialMetadata).peer.deviceId===oldId)ids.push(credentials.getString(0));}finally{credentials.close();}
  for(const id of ids){await db.executeSql('UPDATE Credential SET revoked=1,revision=revision+1 WHERE id=?',[id]);revoked.push(id);}
  await db.executeSql('UPDATE RegisteredInstallation SET state=\'REVOKED\',secretHash=NULL WHERE deviceId=? AND groupId=?',[oldId,old.spaceId]);
 }
 const binding:Binding={deviceId:peer.deviceId,groupId:peer.groupId,holderInstanceId:peer.holderInstanceId};
 await db.executeSql('INSERT INTO Device (id,groupId,revision,metadataJson) VALUES (?,\'space-membership\',1,?) ON CONFLICT(id) DO UPDATE SET revision=revision+1,metadataJson=excluded.metadataJson',[installationKey(installationId),JSON.stringify(binding)]);
 return revoked;
}
