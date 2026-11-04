import {randomUUID} from 'node:crypto';
import {protocolId} from '@harmony/scheduler-core';
import {DisplaySession,PrismaClient} from '../generated/client';
import {Peer} from './channel';

function view(s:DisplaySession,now:number){
  const state=Number(s.expiresAt)<=now&&['INVITED','ACTIVE'].includes(s.state)?'EXPIRED':s.state;
  return {id:s.id,sourceHolderId:s.sourceHolderId,viewerHolderId:s.viewerHolderId,state,
    version:s.viewVersion,shownVersion:s.shownVersion,expiresAt:Number(s.expiresAt),text:state==='ACTIVE'?s.content:null};
}
export class DisplaySessions {
  constructor(private db:PrismaClient,private now=Date.now){}
  async invite(peer:Peer,body:{viewerHolderId:string;leaseMs:number}){
    if(!body||!protocolId(body.viewerHolderId)||body.viewerHolderId===peer.holderInstanceId||
      !Number.isSafeInteger(body.leaseMs)||body.leaseMs<1000||body.leaseMs>3600000)throw Error('DISPLAY_INVITE_INVALID');
    const now=this.now();
    return view(await this.db.displaySession.create({data:{id:randomUUID(),groupId:peer.groupId,sourceHolderId:peer.holderInstanceId,
      viewerHolderId:body.viewerHolderId,state:'INVITED',expiresAt:now+body.leaseMs}}),now);
  }
  async inbox(peer:Peer){
    const now=this.now();
    return (await this.db.displaySession.findMany({where:{groupId:peer.groupId,viewerHolderId:peer.holderInstanceId,
      state:{in:['INVITED','ACTIVE']},expiresAt:{gt:now}},orderBy:{expiresAt:'asc'}})).map(s=>view(s,now));
  }
  async status(peer:Peer,id:string){
    const s=await this.db.displaySession.findFirst({where:{id,groupId:peer.groupId,OR:[{sourceHolderId:peer.holderInstanceId},{viewerHolderId:peer.holderInstanceId}]}});
    if(!s)throw Error('DISPLAY_SESSION_UNKNOWN');
    return view(s,this.now());
  }
  async change(peer:Peer,id:string,action:string,body:{version?:number;text?:string}){
    return this.db.$transaction(async tx=>{
      const s=await tx.displaySession.findFirst({where:{id,groupId:peer.groupId}});
      const source=action==='publish'||action==='revoke';
      if(!s||(source?s.sourceHolderId:s.viewerHolderId)!==peer.holderInstanceId)throw Error('DISPLAY_SESSION_UNKNOWN');
      const now=this.now(),current=view(s,now);
      if(action==='leave'||action==='revoke'){
        if(!['INVITED','ACTIVE'].includes(current.state))return current;
        return view(await tx.displaySession.update({where:{id},data:{state:source?'REVOKED':'LEFT',content:null}}),now);
      }
      if(action==='accept'&&current.state==='INVITED')return view(await tx.displaySession.update({where:{id},data:{state:'ACTIVE'}}),now);
      if(current.state!=='ACTIVE')throw Error('DISPLAY_LEASE_INACTIVE');
      if(action==='accept')return current;
      if(!body||!Number.isSafeInteger(body.version)||body.version!<1)throw Error('DISPLAY_VERSION_INVALID');
      if(action==='publish'){
        if(typeof body.text!=='string'||!body.text.trim()||Buffer.byteLength(body.text)>16384)throw Error('DISPLAY_CONTENT_INVALID');
        if(body.version===s.viewVersion&&body.text===s.content)return current;
        if(body.version!==s.viewVersion+1)throw Error('DISPLAY_VERSION_CONFLICT');
        return view(await tx.displaySession.update({where:{id},data:{viewVersion:body.version,content:body.text}}),now);
      }
      if(action!=='shown'||body.version!==s.viewVersion)throw Error('DISPLAY_VERSION_CONFLICT');
      return view(await tx.displaySession.update({where:{id},data:{shownVersion:body.version}}),now);
    });
  }
}
