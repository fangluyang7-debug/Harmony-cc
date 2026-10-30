import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { PrismaClient } from '../generated/client';
import { protocolId } from '@harmony/scheduler-core';
import { Peer } from './channel';
export interface Invitation {version:2;inviteId:string;code:string;address:string;certificate:string;fingerprint:string;expiresAt:number;groupId:string;}
interface InviteData {secretHash:string;expiresAt:number;used:boolean;principalId:string;deviceId:string;domain:string;}
interface CredentialData {peer:Peer;expiresAt:number;domain:string;}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export const certificateFingerprint=(pem:string)=>new X509Certificate(pem).fingerprint256.replaceAll(':','').toLowerCase();
export class PairingService {
  private readonly revocations=new Set<(id:string)=>void>();
  constructor(private readonly db:PrismaClient,private readonly cert:string,private readonly domain:string,private readonly now:()=>number=Date.now){}
  onRevoked(listener:(id:string)=>void){this.revocations.add(listener);return ()=>this.revocations.delete(listener);}
  async invite(groupId:string,principalId:string,deviceId:string,address:string,ttlMs=300000):Promise<Invitation>{
    const url=new URL(address);
    if(![groupId,principalId,deviceId].every(protocolId)||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>600000)throw Error('INVITE_INVALID');
    const id=randomUUID(),code=randomBytes(18).toString('base64url'),expiresAt=this.now()+ttlMs;
    const data:InviteData={secretHash:hash(code),expiresAt,used:false,principalId,deviceId,domain:this.domain};
    await this.db.invite.create({data:{id,groupId,revision:1,metadataJson:JSON.stringify(data)}});
    return {version:2,inviteId:id,code,address:url.origin,certificate:this.cert,fingerprint:certificateFingerprint(this.cert),expiresAt,groupId};
  }
  async exchange(request:{inviteId:string;code:string;holderInstanceId:string}){
    if(!request||Object.keys(request).sort().join('|')!=='code|holderInstanceId|inviteId'||![request.inviteId,request.holderInstanceId].every(protocolId)||typeof request.code!=='string'||!/^[A-Za-z0-9_-]{24}$/.test(request.code))throw Error('PAIRING_INVALID');
    const credential=randomBytes(32).toString('base64url'),credentialId=randomUUID();
    const peer=await this.db.$transaction(async tx=>{
      const row=await tx.invite.findUnique({where:{id:request.inviteId}});
      if(!row)throw Error('INVITE_INVALID');
      const invite=JSON.parse(row.metadataJson) as InviteData;
      if(invite.used||invite.expiresAt<=this.now()||invite.secretHash!==hash(request.code)||invite.domain!==this.domain)throw Error('INVITE_INVALID');
      const history=await tx.credential.findMany({where:{groupId:row.groupId,holderInstanceId:request.holderInstanceId}});
      if(history.some(old=>{const binding=JSON.parse(old.metadataJson) as CredentialData;return binding.peer.deviceId!==invite.deviceId||binding.peer.principalId!==invite.principalId;}))throw Error('HOLDER_BINDING_CHANGED');
      if(await tx.credential.findFirst({where:{groupId:row.groupId,holderInstanceId:request.holderInstanceId,revoked:false}}))throw Error('HOLDER_ALREADY_REGISTERED');
      const used=await tx.invite.updateMany({where:{id:row.id,revision:row.revision},data:{revision:{increment:1},metadataJson:JSON.stringify({...invite,used:true})}});
      if(used.count!==1)throw Error('INVITE_USED');
      const peer:Peer={groupId:row.groupId,holderInstanceId:request.holderInstanceId,deviceId:invite.deviceId,principalId:invite.principalId,credentialId};
      const data:CredentialData={peer,domain:this.domain,expiresAt:this.now()+30*24*3600000};
      await tx.credential.create({data:{id:credentialId,groupId:row.groupId,holderInstanceId:peer.holderInstanceId,tokenHash:hash(credential),revoked:false,revision:1,metadataJson:JSON.stringify(data)}});
      return peer;
    });
    return {credential,peer};
  }
  async authenticate(token:string):Promise<Peer>{
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))throw Error('CREDENTIAL_INVALID');
    const row=await this.db.credential.findUnique({where:{tokenHash:hash(token)}});
    if(!row||row.revoked)throw Error('CREDENTIAL_REVOKED');
    const data=JSON.parse(row.metadataJson) as CredentialData;
    if(data.domain!==this.domain||data.expiresAt<=this.now())throw Error('CREDENTIAL_EXPIRED');
    return data.peer;
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
  async revoke(credentialId:string){await this.db.credential.update({where:{id:credentialId},data:{revoked:true,revision:{increment:1}}});for(const listener of this.revocations)listener(credentialId);}
}
