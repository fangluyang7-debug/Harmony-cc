import {Prisma} from '../generated/client';
import type {Peer} from './channel';

// Installation identity survives space changes; holder identity remains space-scoped.
// Reuse the durable namespaced Device store, separate from physical-budget records.
const deviceKey=(id:string)=>JSON.stringify(['space-device-installation',id]);
const installationKey=(id:string)=>JSON.stringify(['space-installation',id]);
interface Registration {installationId:string;}
interface ActiveDevice {deviceId:string;groupId:string;holderInstanceId:string;}
/** A cancelled, never-dispatched job has no device resources to reconcile.
 * Missing jobs, expired reservations and admitted attempts remain conservative. */
export async function appReservationSettled(db:Prisma.TransactionClient,reservation:{id:string;groupId:string;principalId:string}):Promise<boolean>{
 const attempt=await db.attempt.findUnique({where:{id:reservation.id}});
 if(attempt)return attempt.groupId===reservation.groupId&&(attempt.state==='REJECTED'||!!attempt.recordJson&&JSON.parse(attempt.recordJson).resourcesSettled===true);
 const job=await db.cpuJob.findUnique({where:{id:reservation.id}});
 return !!job&&job.groupId===reservation.groupId&&job.principalId===reservation.principalId&&job.state==='CANCELLED';
}
export async function deviceMembershipActive(db:Prisma.TransactionClient,deviceId:string):Promise<boolean>{
 const registration=await db.device.findUnique({where:{id:deviceKey(deviceId)}});
 if(!registration)return true; // Legacy/manual hosts are not guessed from names or accounts.
 const binding=await db.device.findUnique({where:{id:installationKey((JSON.parse(registration.metadataJson) as Registration).installationId)}});
 return !!binding&&(JSON.parse(binding.metadataJson) as ActiveDevice).deviceId===deviceId;
}
export async function registerDeviceMembership(db:Prisma.TransactionClient,installationId:string,deviceId:string,previousDeviceId:string|undefined,userId:string,knownDeviceIds:unknown=[]){
 if(!/^[a-f0-9-]{36}$/.test(installationId))throw Error('DEVICE_INSTALLATION_INVALID');
 const id=installationKey(installationId),binding=await db.device.findUnique({where:{id}});
 // A previousDeviceId unknown here belongs to another coordinator; ignore it like knownDeviceIds.
 const previous=!binding&&previousDeviceId?await db.spaceDevice.findUnique({where:{id:previousDeviceId}}):null;
 if(previous&&previous.userId!==userId)throw Error('DEVICE_FORBIDDEN');
 if(!binding&&previousDeviceId&&previous){
  const old=await db.device.findUnique({where:{id:deviceKey(previousDeviceId)}});
  if(old&&(JSON.parse(old.metadataJson) as Registration).installationId!==installationId)throw Error('DEVICE_INSTALLATION_CONFLICT');
  await db.device.upsert({where:{id:deviceKey(previousDeviceId)},create:{id:deviceKey(previousDeviceId),groupId:previous.spaceId,revision:1,metadataJson:JSON.stringify({installationId})},update:{}});
  await db.device.create({data:{id,groupId:'space-membership',revision:1,metadataJson:JSON.stringify({deviceId:previous.id,groupId:previous.spaceId,holderInstanceId:previous.holderId})}});
 }
 if(!Array.isArray(knownDeviceIds)||knownDeviceIds.length>200||knownDeviceIds.some(id=>typeof id!=='string'))throw Error('DEVICE_INSTALLATION_INVALID');
 for(const knownId of new Set<string>(knownDeviceIds)){
  if(knownId===deviceId)continue;
  const historical=await db.spaceDevice.findUnique({where:{id:knownId}});if(!historical||historical.userId!==userId)continue;
  const existing=await db.device.findUnique({where:{id:deviceKey(knownId)}});
  if(existing){if((JSON.parse(existing.metadataJson) as Registration).installationId!==installationId)throw Error('DEVICE_INSTALLATION_CONFLICT');continue;}
  await db.device.create({data:{id:deviceKey(knownId),groupId:historical.spaceId,revision:1,metadataJson:JSON.stringify({installationId})}});
 }
 const current=await db.spaceDevice.findUniqueOrThrow({where:{id:deviceId}});
 const existing=await db.device.findUnique({where:{id:deviceKey(deviceId)}});
 if(existing){if((JSON.parse(existing.metadataJson) as Registration).installationId!==installationId)throw Error('DEVICE_INSTALLATION_CONFLICT');}
 else await db.device.create({data:{id:deviceKey(deviceId),groupId:current.spaceId,revision:1,metadataJson:JSON.stringify({installationId})}});
}
export async function activateDeviceMembership(db:Prisma.TransactionClient,peer:Peer):Promise<string[]>{
 const row=await db.device.findUnique({where:{id:deviceKey(peer.deviceId)}});if(!row)return [];
 const installationId=(JSON.parse(row.metadataJson) as Registration).installationId,id=installationKey(installationId);
 const revoked:string[]=[];
 const linked=(await db.device.findMany()).filter(r=>r.id.startsWith('["space-device-installation",')&&(JSON.parse(r.metadataJson) as Registration).installationId===installationId).map(r=>JSON.parse(r.id)[1] as string);
 for(const oldId of linked.filter(id=>id!==peer.deviceId)){
  const old=await db.spaceDevice.findUnique({where:{id:oldId}});if(!old)continue;
  const apps=await db.registeredInstallation.findMany({where:{deviceId:oldId,groupId:old.spaceId}});
  // Reservations are durable history, not a live-work flag. A settled attempt
  // must not prevent reconnecting this installation forever. Unknown or merely
  // expired reservations still block: a deadline is not proof of settlement.
  const reservations=await db.appJobReservation.findMany({where:{appInstanceId:{in:apps.map(a=>a.id)}}});
  for(const reservation of reservations){
   if(await appReservationSettled(db,reservation))continue;
   throw Error('SPACE_SWITCH_BUSY');
  }
  const pending=await db.attempt.findMany({where:{groupId:old.spaceId,holderInstanceId:{in:[old.holderId,...apps.map(a=>a.holderInstanceId)]}}});
  if(pending.some(a=>a.state!=='REJECTED'&&(!a.recordJson||!JSON.parse(a.recordJson).resourcesSettled)))throw Error('SPACE_SWITCH_BUSY');
  const credentials=await db.credential.findMany({where:{groupId:old.spaceId,revoked:false}});
  for(const credential of credentials){if(JSON.parse(credential.metadataJson).peer.deviceId!==oldId)continue;
   await db.credential.update({where:{id:credential.id},data:{revoked:true,revision:{increment:1}}});revoked.push(credential.id);
  }
  await db.registeredInstallation.updateMany({where:{deviceId:oldId,groupId:old.spaceId},data:{state:'REVOKED',secretHash:null}});
 }
 const metadataJson=JSON.stringify({deviceId:peer.deviceId,groupId:peer.groupId,holderInstanceId:peer.holderInstanceId});
 await db.device.upsert({where:{id},create:{id,groupId:'space-membership',revision:1,metadataJson},update:{revision:{increment:1},metadataJson}});
 return revoked;
}
