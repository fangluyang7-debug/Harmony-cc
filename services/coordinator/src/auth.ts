import { createHash, randomInt, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { PrismaClient } from '../generated/client';
import { protocolId } from '@harmony/scheduler-core';
import { Peer } from './channel';
import {activateDeviceMembership,deviceMembershipActive,registerDeviceMembership,appReservationSettled} from './device-membership';
export interface Invitation {version:2;inviteId:string;code:string;address:string;certificate:string;fingerprint:string;expiresAt:number;groupId:string;}
interface InviteData {secretHash:string;expiresAt:number;used:boolean;principalId:string;deviceId:string;domain:string;rejoinInstallationId?:string;rejoinHolderId?:string;}
interface CredentialData {peer:Peer;expiresAt:number;domain:string;}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export const certificateFingerprint=(pem:string)=>new X509Certificate(pem).fingerprint256.replaceAll(':','').toLowerCase();
export class PairingService {
  private readonly shortCodes=new Map<string,{inviteId:string;code:string;expiresAt:number}>();
  private readonly codeAttempts=new Map<string,{count:number;expiresAt:number}>();
  issuePairingCode(invitation:Invitation){
    const now=this.now();
    for(const [key,value] of this.shortCodes)if(value.expiresAt<=now)this.shortCodes.delete(key);
    if(this.shortCodes.size>=1000)throw Error('PAIRING_BUSY');
    let code:string;do{code=String(randomInt(1000000)).padStart(6,'0');}while(this.shortCodes.has(code));
    const expiresAt=Math.min(invitation.expiresAt,now+300000);
    this.shortCodes.set(code,{inviteId:invitation.inviteId,code:invitation.code,expiresAt});
    return {pairingCode:code,pairingCodeExpiresAt:expiresAt};
  }
  async redeemPairingCode(code:unknown,address:string,remote:string){
    const now=this.now();
    for(const [key,value] of this.codeAttempts)if(value.expiresAt<=now)this.codeAttempts.delete(key);
    if(this.codeAttempts.size>=2048&&!this.codeAttempts.has(remote))throw Error('PAIRING_REJECTED');
    for(const key of ['global',remote]){
      const attempt=this.codeAttempts.get(key)??{count:0,expiresAt:now+300000};
      if(attempt.count>=(key==='global'?100:5))throw Error('PAIRING_RATE_LIMITED');
      attempt.count++;this.codeAttempts.set(key,attempt);
    }
    if(typeof code!=='string'||!/^\d{6}$/.test(code))throw Error('PAIRING_REJECTED');
    const value=this.shortCodes.get(code);
    if(!value||value.expiresAt<=now)throw Error('PAIRING_REJECTED');
    const result=await this.readDeviceInvite({inviteId:value.inviteId,code:value.code},address);
    this.codeAttempts.delete(remote);return result;
  }
  private readonly revocations=new Set<(id:string)=>void>();
  constructor(private readonly db:PrismaClient,private readonly cert:string,private readonly domain:string,private readonly now:()=>number=Date.now){}
  onRevoked(listener:(id:string)=>void){this.revocations.add(listener);return ()=>this.revocations.delete(listener);}
  publicFingerprint(){return certificateFingerprint(this.cert);}
  async invite(groupId:string,principalId:string,deviceId:string,address:string,ttlMs=300000):Promise<Invitation>{
    const url=new URL(address);
    if(![groupId,principalId,deviceId].every(protocolId)||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>600000)throw Error('INVITE_INVALID');
    const id=randomUUID(),code=randomBytes(18).toString('base64url'),expiresAt=this.now()+ttlMs;
    const data:InviteData={secretHash:hash(code),expiresAt,used:false,principalId,deviceId,domain:this.domain};
    await this.db.invite.create({data:{id,groupId,revision:1,metadataJson:JSON.stringify(data)}});
    return {version:2,inviteId:id,code,address:url.origin,certificate:this.cert,fingerprint:certificateFingerprint(this.cert),expiresAt,groupId};
  }
  private checkInvite(invite:InviteData,code:string){
    if((invite.used&&!invite.rejoinInstallationId)||invite.expiresAt<=this.now()||invite.secretHash!==hash(code)||invite.domain!==this.domain)throw Error('INVITE_INVALID');
  }
  async readDeviceInvite(request:{inviteId:string;code:string},address:string){
    if(!request||Object.keys(request).sort().join('|')!=='code|inviteId'||!protocolId(request.inviteId)||
       typeof request.code!=='string'||!/^[A-Za-z0-9_-]{24}$/.test(request.code))throw Error('INVITE_INVALID');
    const row=await this.db.invite.findUnique({where:{id:request.inviteId}});
    if(!row)throw Error('INVITE_INVALID');
    const invite=JSON.parse(row.metadataJson) as InviteData;
    this.checkInvite(invite,request.code);
    const device=await this.db.spaceDevice.findUnique({where:{id:invite.deviceId}});
    if(!device||device.spaceId!==row.groupId||device.userId!==invite.principalId)throw Error('INVITE_INVALID');
    const invitation:Invitation={version:2,inviteId:row.id,code:request.code,address:new URL(address).origin,certificate:this.cert,
      fingerprint:certificateFingerprint(this.cert),expiresAt:invite.expiresAt,groupId:row.groupId};
    return {invitation:{...invitation,tlsMode:'pinned'},holderInstanceId:device.holderId,
      domain:this.domain,contribution:JSON.parse(device.settingsJson)};
  }
  async exchange(request:{inviteId:string;code:string;holderInstanceId:string;installationId?:string;previousDeviceId?:string;knownDeviceIds?:string[]}){
    if(!request||Object.keys(request).some(k=>!['code','holderInstanceId','inviteId','installationId','previousDeviceId','knownDeviceIds'].includes(k))||![request.inviteId,request.holderInstanceId].every(protocolId)||typeof request.code!=='string'||!/^[A-Za-z0-9_-]{24}$/.test(request.code))throw Error('PAIRING_INVALID');
    const credential=randomBytes(32).toString('base64url'),credentialId=randomUUID();
    let revoked:string[]=[];
    const peer=await this.db.$transaction(async tx=>{
      const row=await tx.invite.findUnique({where:{id:request.inviteId}});
      if(!row)throw Error('INVITE_INVALID');
      const invite=JSON.parse(row.metadataJson) as InviteData;
      this.checkInvite(invite,request.code);
      if(invite.used&&(invite.rejoinInstallationId!==request.installationId||invite.rejoinHolderId!==request.holderInstanceId))throw Error('INVITE_INVALID');
      const history=await tx.credential.findMany({where:{groupId:row.groupId,holderInstanceId:request.holderInstanceId}});
      if(history.some(old=>{const binding=JSON.parse(old.metadataJson) as CredentialData;return binding.peer.deviceId!==invite.deviceId||binding.peer.principalId!==invite.principalId;}))throw Error('HOLDER_BINDING_CHANGED');
      if(await tx.credential.findFirst({where:{groupId:row.groupId,holderInstanceId:request.holderInstanceId,revoked:false}}))throw Error('HOLDER_ALREADY_REGISTERED');
      const used=await tx.invite.updateMany({where:{id:row.id,revision:row.revision},data:{revision:{increment:1},metadataJson:JSON.stringify({...invite,used:true,...(request.installationId?{rejoinInstallationId:request.installationId,rejoinHolderId:request.holderInstanceId}:{})})}});
      if(used.count!==1)throw Error('INVITE_USED');
      const peer:Peer={groupId:row.groupId,holderInstanceId:request.holderInstanceId,deviceId:invite.deviceId,principalId:invite.principalId,credentialId};
      if(request.installationId&&await tx.spaceDevice.findUnique({where:{id:invite.deviceId}}))await registerDeviceMembership(tx,request.installationId,invite.deviceId,request.previousDeviceId,invite.principalId,request.knownDeviceIds??[]);
      revoked=await activateDeviceMembership(tx,peer);
      const data:CredentialData={peer,domain:this.domain,expiresAt:this.now()+30*24*3600000};
      await tx.credential.create({data:{id:credentialId,groupId:row.groupId,holderInstanceId:peer.holderInstanceId,tokenHash:hash(credential),revoked:false,revision:1,metadataJson:JSON.stringify(data)}});
      return peer;
    });
    for(const id of revoked)for(const listener of this.revocations)listener(id);
    return {credential,peer};
  }
  async authenticate(token:string):Promise<Peer>{
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))throw Error('CREDENTIAL_INVALID');
    const row=await this.db.credential.findUnique({where:{tokenHash:hash(token)}});
    if(!row||row.revoked)throw Error('CREDENTIAL_REVOKED');
    const data=JSON.parse(row.metadataJson) as CredentialData;
    if(data.domain!==this.domain||data.expiresAt<=this.now())throw Error('CREDENTIAL_EXPIRED');
    return this.context(data.peer);
  }
  private async context(peer:Peer):Promise<Peer>{
    if(!await deviceMembershipActive(this.db,peer.deviceId))throw Error('DEVICE_LEFT_SPACE');
    if(!peer.app)return peer;
    const i=await this.db.registeredInstallation.findUnique({where:{id:peer.app.appInstanceId}}),app=i?await this.db.registeredApp.findUnique({where:{id:i.appId}}):null;
    if(!i||!app||i.state!=='ACTIVE'||i.groupId!==peer.groupId||i.principalId!==peer.principalId||i.deviceId!==peer.deviceId||i.holderInstanceId!==peer.holderInstanceId||app.id!==peer.app.appId)throw Error('APP_CREDENTIAL_REVOKED');
    return {...peer,app:{groupId:i.groupId,principalId:i.principalId,appId:app.id,appInstanceId:i.id,allowedContracts:JSON.parse(app.contractsJson)}};
  }
  async activePeers():Promise<Peer[]>{
    const rows=await this.db.credential.findMany({where:{revoked:false}});
    const result:Peer[]=[];
    for(const row of rows){const data=JSON.parse(row.metadataJson) as CredentialData;if(data.domain!==this.domain||data.expiresAt<=this.now())continue;try{result.push(await this.context(data.peer));}catch{/* Revoked installations do not contribute targets. */}}
    return result;
  }
  async rotate(token:string){
    const old=await this.authenticate(token),credential=randomBytes(32).toString('base64url'),credentialId=randomUUID(),peer={...old,credentialId};
    await this.db.$transaction(async tx=>{
      const changed=await tx.credential.updateMany({where:{id:old.credentialId,revoked:false},data:{revoked:true,revision:{increment:1}}});
      if(changed.count!==1)throw Error('CREDENTIAL_REVOKED');
      await tx.credential.create({data:{id:credentialId,groupId:peer.groupId,holderInstanceId:peer.holderInstanceId,tokenHash:hash(credential),revoked:false,revision:1,
        metadataJson:JSON.stringify({peer,domain:this.domain,expiresAt:this.now()+30*24*3600000})}});
    });
    for(const listener of this.revocations)listener(old.credentialId);
    return {credential,peer};
  }
  async leaveDevice(peer:Peer){
    if(peer.app)throw Error('DEVICE_OWNER_REQUIRED');
    const revoked=await this.db.$transaction(async tx=>{
      const apps=await tx.registeredInstallation.findMany({where:{deviceId:peer.deviceId,groupId:peer.groupId}});
      const holders=[peer.holderInstanceId,...apps.map(a=>a.holderInstanceId)];
      const pending=await tx.attempt.findMany({where:{groupId:peer.groupId,holderInstanceId:{in:holders}}});
      if(pending.some(a=>a.state!=='REJECTED'&&(!a.recordJson||!JSON.parse(a.recordJson).resourcesSettled)))throw Error('SPACE_SWITCH_BUSY');
      const reservations=await tx.appJobReservation.findMany({where:{appInstanceId:{in:apps.map(a=>a.id)}}});
      for(const r of reservations)if(!await appReservationSettled(tx,r))throw Error('SPACE_SWITCH_BUSY');
      const credentials=(await tx.credential.findMany({where:{groupId:peer.groupId,revoked:false}})).filter(c=>JSON.parse(c.metadataJson).peer.deviceId===peer.deviceId);
      for(const c of credentials)await tx.credential.update({where:{id:c.id},data:{revoked:true,revision:{increment:1}}});
      await tx.registeredInstallation.updateMany({where:{deviceId:peer.deviceId,groupId:peer.groupId},data:{state:'REVOKED',secretHash:null}});
      const registration=await tx.device.findUnique({where:{id:JSON.stringify(['space-device-installation',peer.deviceId])}});
      if(registration){const key=JSON.stringify(['space-installation',JSON.parse(registration.metadataJson).installationId]),binding=await tx.device.findUnique({where:{id:key}});if(binding&&JSON.parse(binding.metadataJson).deviceId===peer.deviceId)await tx.device.update({where:{id:key},data:{revision:{increment:1},metadataJson:JSON.stringify({left:true})}});}
      return credentials.map(c=>c.id);
    });
    for(const id of revoked)for(const listener of this.revocations)listener(id);return {left:true};
  }
  async revoke(credentialId:string){await this.db.credential.update({where:{id:credentialId},data:{revoked:true,revision:{increment:1}}});for(const listener of this.revocations)listener(credentialId);}
}
