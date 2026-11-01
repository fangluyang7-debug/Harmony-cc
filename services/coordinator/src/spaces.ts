import { SpaceEvents } from './space-events';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { PrismaClient } from '../generated/client';
import { CoordinatorConfig } from './config';
import { PairingService } from './auth';
import { AllotmentIssuer } from './allotments';
import { DeviceDirectory } from './directory';
import { CpuJobs } from './cpu-jobs';
import { ArtifactChannel } from '@harmony/resource-transport';
import { Peer } from './channel';
import { SnapshotBuilder } from './planning';
import {AppRegistry} from './apps';
import {SdkJobs} from './sdk';
import {SchedulerSdk,SdkPort} from '@harmony/scheduler-client';

const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const passwordHash=(password:string,salt:string)=>new Promise<Buffer>((resolve,reject)=>scrypt(password,salt,64,(e,v)=>e?reject(e):resolve(v)));
function label(v:unknown,max=60){if(typeof v!=='string'||!v.trim()||v.trim().length>max)throw Error('INPUT_INVALID');return v.trim();}
export function contribution(v:any){
  if(!v||!['dedicated','windows-idle','paused'].includes(v.ownerMode)||!Number.isInteger(v.maxCpuThreads)||v.maxCpuThreads<1||v.maxCpuThreads>256||!Number.isSafeInteger(v.maxMemoryBytes)||v.maxMemoryBytes<67108864||v.maxMemoryBytes>1099511627776||!Number.isSafeInteger(v.reserveMemoryBytes)||v.reserveMemoryBytes<0||v.reserveMemoryBytes>1099511627776)throw Error('CONTRIBUTION_INVALID');
  return {ownerMode:v.ownerMode,maxCpuThreads:v.maxCpuThreads,maxMemoryBytes:v.maxMemoryBytes,reserveMemoryBytes:v.reserveMemoryBytes};
}

/** Browser accounts and room membership are separate from device execution credentials. */
export class TeamSpaces {
  private readonly streams=new Map<()=>void,string>();
  close(){for(const close of this.streams.keys())close();}
  private readonly authAttempts=new Map<string,{count:number;until:number}>();
  constructor(private readonly db:PrismaClient,private readonly auth:PairingService,private readonly allotments:AllotmentIssuer,
    private readonly directory:DeviceDirectory,private readonly jobs:CpuJobs,private readonly artifacts:ArtifactChannel,
    private readonly config:CoordinatorConfig,private readonly status:()=>{ready:boolean;epoch:number},private readonly snapshots:SnapshotBuilder,private readonly events:SpaceEvents,private readonly apps:AppRegistry,private readonly sdk:SdkJobs){}
  async session(cookie:string|undefined){
    const token=/(?:^|;\s*)harmony_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(cookie??'')?.[1];
    const session=token?await this.db.spaceSession.findUnique({where:{id:hash(token)}}):null;
    if(!session||session.expiresAt<=Date.now())throw Error('LOGIN_REQUIRED');
    const user=await this.db.spaceUser.findUnique({where:{id:session.userId}});if(!user)throw Error('LOGIN_REQUIRED');return {user,session};
  }
  async member(userId:string,spaceId:string,roles=['OWNER','MEMBER','VIEWER']){
    const m=await this.db.spaceMember.findUnique({where:{spaceId_userId:{spaceId,userId}}});
    if(!m||!roles.includes(m.role))throw Error('SPACE_FORBIDDEN');return m;
  }
  peer(userId:string,spaceId:string):Peer{return {groupId:spaceId,principalId:userId,deviceId:'web-'+userId,holderInstanceId:'web-'+userId,credentialId:'web-'+userId};}
  private appPeer(userId:string,spaceId:string){return this.apps.console(this.peer(userId,spaceId),this.sdk.contractIds(),[{resourcePoolId:'cpu',amount:4},{resourcePoolId:'ram',amount:1073741824}]);}
  async deviceSettings(peer:Peer){const d=await this.db.spaceDevice.findUnique({where:{id:peer.deviceId}});return d&&d.spaceId===peer.groupId&&d.holderId===peer.holderInstanceId?JSON.parse(d.settingsJson):null;}
  async dashboard(userId:string,spaceId:string){
    const me=await this.member(userId,spaceId),space=await this.db.teamSpace.findUniqueOrThrow({where:{id:spaceId}}),now=Date.now();
    const [members,users,registered,profiles,states,rows,attempts]=await Promise.all([
      this.db.spaceMember.findMany({where:{spaceId}}),this.db.spaceUser.findMany({where:{id:{in:(await this.db.spaceMember.findMany({where:{spaceId}})).map(m=>m.userId)}},select:{id:true,name:true}}),
      this.db.spaceDevice.findMany({where:{spaceId}}),this.directory.profiles(spaceId),this.db.capabilityState.findMany({where:{groupId:spaceId}}),
      this.db.cpuJob.findMany({where:{groupId:spaceId},take:100}),this.db.attempt.findMany({where:{groupId:spaceId}})]);
    let available:string[]=[];try{const s=await this.snapshots.build(spaceId);available=s.policy.revoked?[]:s.snapshot.candidates.filter(c=>s.policy.allowedTargetIds.includes(c.targetId)&&c.observedAt+c.ttlMs>now).map(c=>c.targetId);}catch{}
    const devices=registered.map(d=>{const p=profiles.find(p=>p.deviceId===d.id),sample=p?.ownerActivity;
      const online=!!sample&&sample.sampledAt+sample.ttlMs>now;
      return {id:d.id,name:d.name,userId:d.userId,online,lastSeen:sample?.sampledAt??null,settings:JSON.parse(d.settingsJson),profile:p??null,
        capabilities:(p?.executors??[]).map(e=>{const state=JSON.parse(states.find(s=>s.id===JSON.stringify([spaceId,p!.holderInstanceId,e.target.targetId]))?.metadataJson??'{"state":"DISCOVERED"}').state;
          return {capability:e.contract.capability,targetId:e.target.targetId,backend:e.target.backend,available:online&&available.includes(e.target.targetId)&&['ACTIVE','CANARY'].includes(state),state};})};});
    return {space,me,members:members.map(m=>({...m,name:users.find(u=>u.id===m.userId)?.name??'成员'})),devices,
      jobs:rows.map(r=>{const d=JSON.parse(r.metadataJson);return {id:r.id,userId:r.principalId,state:attempts.find(a=>a.id===r.id)?.state??r.state,deviceId:d.offer.target.deviceId,capability:d.offer.task.contract.capability,reason:d.offer.reasonCode,rejection:attempts.find(a=>a.id===r.id)?.rejectionJson?JSON.parse(attempts.find(a=>a.id===r.id)!.rejectionJson!):null};}),
      coordinator:{...this.status(),location:this.config.proxy&&this.config.publicUrl&&!['localhost','127.0.0.1','[::1]'].includes(new URL(this.config.publicUrl).hostname)?'CLOUD':'LOCAL_DEVELOPMENT',domain:this.config.domain,address:this.config.publicUrl??null},updatedAt:now};
  }
  private stream(req:any,res:any,spaceId:string,sessionId:string){
    res.status(200).set({'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});
    res.flushHeaders();let closed=false,busy=false,dirty=true;
    const stop=()=>{if(closed)return;closed=true;clearInterval(timer);unsubscribe();this.streams.delete(stop);res.end();};
    const send=async()=>{
      if(closed||busy)return;busy=true;
      try{
        const {user}=await this.session(req.headers.cookie);await this.member(user.id,spaceId);
        if(closed)return;
        const text=dirty?'event: changed\ndata: {}\n\n':': heartbeat\n\n';dirty=false;
        if(!res.write(text))stop();
      }catch{stop();}finally{busy=false;if(dirty&&!closed)void send();}
    };
    const unsubscribe=this.events.subscribe(spaceId,()=>{dirty=true;void send();});
    const timer=setInterval(()=>{void send();},15000);timer.unref();
    this.streams.set(stop,sessionId);res.on('close',stop);void send();
  }
  async handle(req:any,res:any){
    res.setHeader('Cache-Control','no-store');
    try{
      if(!this.status().ready)throw Error('COORDINATOR_NOT_READY');
      if(req.method==='POST')res.once('finish',()=>{if(res.statusCode<300){const id=req.path.replace(/^\/v2\/spaces/,'').split('/').filter(Boolean)[0];if(id)this.events.changed(id);}});
      const route=req.path.replace(/^\/v2\/spaces/,'')||'/',body=req.body??{},method=req.method;
      if(method==='POST'||method==='PUT'){
        if(method==='POST'&&!req.is('application/json'))throw Error('JSON_REQUIRED');
        const origin=req.headers.origin,expected=this.config.publicUrl?new URL(this.config.publicUrl).origin:(this.config.proxy?'http:':'https:')+'//'+req.headers.host;
        if(origin&&origin!==expected)throw Error('ORIGIN_REJECTED');
      }
      if(method==='POST'&&['/register','/login'].includes(route)){
        const account=label(body.account,80).toLowerCase();if(!/^[a-z0-9@._+-]{3,80}$/.test(account)||typeof body.password!=='string'||body.password.length<8||body.password.length>128)throw Error('ACCOUNT_INVALID');
        const key=account,old=this.authAttempts.get(key),now=Date.now();
        if(old&&old.until>now&&old.count>=12)throw Error('LOGIN_RATE_LIMIT');
        if(this.authAttempts.size>2000)this.authAttempts.clear();this.authAttempts.set(key,{count:old&&old.until>now?old.count+1:1,until:now+60000});
        let user=await this.db.spaceUser.findUnique({where:{account}});
        if(route==='/register'){
          if(user)throw Error('ACCOUNT_EXISTS');const salt=randomBytes(16).toString('hex');
          user=await this.db.spaceUser.create({data:{id:randomUUID(),account,name:label(body.name),password:salt+':'+(await passwordHash(body.password,salt)).toString('hex')}});
        }else{if(!user)throw Error('LOGIN_INVALID');const [salt,stored]=user.password.split(':');if(!timingSafeEqual(Buffer.from(stored,'hex'),await passwordHash(body.password,salt)))throw Error('LOGIN_INVALID');}
        const token=randomBytes(32).toString('base64url');await this.db.spaceSession.deleteMany({where:{expiresAt:{lt:now}}});
        await this.db.spaceSession.create({data:{id:hash(token),userId:user.id,expiresAt:now+30*86400000}});
        res.setHeader('Set-Cookie',`harmony_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${this.config.proxy&&!this.config.publicUrl?'':'; Secure'}`);
        res.json({user:{id:user.id,name:user.name}});return;
      }
      const {user,session}=await this.session(req.headers.cookie);
      if(route==='/me'&&method==='GET'){res.json({user:{id:user.id,name:user.name},spaces:await this.db.teamSpace.findMany({where:{id:{in:(await this.db.spaceMember.findMany({where:{userId:user.id}})).map(m=>m.spaceId)}}})});return;}
      if(route==='/logout'&&method==='POST'){await this.db.spaceSession.delete({where:{id:session.id}});for(const [close,id] of this.streams)if(id===session.id)close();res.setHeader('Set-Cookie','harmony_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');res.json({ok:true});return;}
      if(route==='/'&&method==='POST'){
        const id=randomUUID();await this.db.$transaction([this.db.teamSpace.create({data:{id,name:label(body.name),createdAt:Date.now()}}),this.db.spaceMember.create({data:{id:randomUUID(),spaceId:id,userId:user.id,role:'OWNER',joinedAt:Date.now()}})]);res.json({id});return;
      }
      if(route==='/join'&&method==='POST'){
        const code=label(body.code,80),invite=await this.db.spaceInvite.findUnique({where:{id:hash(code)}});
        if(!invite||invite.revoked||invite.expiresAt<=Date.now())throw Error('INVITE_EXPIRED');
        await this.db.spaceMember.upsert({where:{spaceId_userId:{spaceId:invite.spaceId,userId:user.id}},create:{id:randomUUID(),spaceId:invite.spaceId,userId:user.id,role:invite.role,joinedAt:Date.now()},update:{}});this.events.changed(invite.spaceId);res.json({id:invite.spaceId});return;
      }
      const parts=route.split('/').filter(Boolean),[spaceId,action,id]=parts;
      const member=await this.member(user.id,spaceId);
      if(action==='events'&&parts.length===2&&method==='GET'){this.stream(req,res,spaceId,session.id);return;}
      if(parts.length===1&&method==='GET'){res.json(await this.dashboard(user.id,spaceId));return;}
      if(action==='invites'&&method==='POST'){
        await this.member(user.id,spaceId,['OWNER']);if(!['MEMBER','VIEWER'].includes(body.role))throw Error('ROLE_INVALID');
        const code=randomBytes(18).toString('base64url'),expiresAt=Date.now()+86400000;
        await this.db.spaceInvite.create({data:{id:hash(code),spaceId,role:body.role,expiresAt}});res.json({code,expiresAt});return;
      }
      if(action==='members'&&method==='POST'){
        await this.member(user.id,spaceId,['OWNER']);if(!['MEMBER','VIEWER'].includes(body.role))throw Error('ROLE_INVALID');
        const target=await this.member(id,spaceId);if(target.role==='OWNER')throw Error('OWNER_ROLE_FIXED');
        await this.db.spaceMember.update({where:{id:target.id},data:{role:body.role}});res.json({ok:true});return;
      }
      if(action==='devices'&&method==='POST'){
        await this.member(user.id,spaceId,['OWNER','MEMBER']);const settings=contribution(body.settings);
        if(id){const d=await this.db.spaceDevice.findUniqueOrThrow({where:{id}});if(d.spaceId!==spaceId||d.userId!==user.id&&member.role!=='OWNER')throw Error('DEVICE_FORBIDDEN');
          const initial=JSON.parse(d.settingsJson);if(settings.maxCpuThreads!==initial.maxCpuThreads||settings.maxMemoryBytes!==initial.maxMemoryBytes)throw Error('CAPACITY_REPAIR_REQUIRED');
          await this.db.spaceDevice.update({where:{id},data:{settingsJson:JSON.stringify(settings)}});res.json({ok:true});return;}
        const address=this.config.publicUrl;if(!address)throw Error('PUBLIC_URL_REQUIRED');
        const deviceId=randomUUID(),holderId=randomUUID();
        await this.allotments.confirmDevice(deviceId,[{resourcePoolId:'cpu',amount:settings.maxCpuThreads},{resourcePoolId:'ram',amount:settings.maxMemoryBytes}],[{groupId:spaceId,holderInstanceId:holderId,appInstanceId:null}]);
        const invitation=await this.auth.invite(spaceId,user.id,deviceId,address,600000);
        await this.db.spaceDevice.create({data:{id:deviceId,spaceId,userId:user.id,holderId,name:label(body.name),settingsJson:JSON.stringify(settings),createdAt:Date.now()}});
        res.json({invitation:{...invitation,tlsMode:this.config.proxy?'public':'pinned'},holderInstanceId:holderId,domain:this.config.domain,contribution:settings});return;
      }
      if(action==='sdk'&&parts[2]==='jobs'){
        await this.member(user.id,spaceId,['OWNER','MEMBER']);const peer=await this.appPeer(user.id,spaceId),jobId=parts[3],operation=parts[4];
        if(!jobId&&method==='POST'){res.json(await this.sdk.submit(peer,body));return;}
        if(jobId&&method==='PUT'&&operation==='input'){if(!Buffer.isBuffer(body))throw Error('BINARY_INPUT_REQUIRED');await this.jobs.writeInput(peer,jobId,body);res.json({uploaded:true});return;}
        if(jobId&&method==='GET'&&operation==='output'){res.type('application/octet-stream').send(await this.jobs.readOutput(peer,jobId));return;}
        if(jobId&&method==='POST'&&operation==='start'){res.json(await this.sdk.start(peer,jobId));return;}
        if(jobId&&method==='POST'&&operation==='cancel'){res.json(await this.sdk.cancel(peer,jobId));return;}
        if(jobId&&method==='GET'&&!operation){res.json(await this.sdk.status(peer,jobId));return;}
      }
      if(action==='jobs'&&method==='POST'){
        // Compatibility gateway uses the SDK too; the web UI uses metadata/binary endpoints above.
        await this.member(user.id,spaceId,['OWNER','MEMBER']);const bytes=Buffer.from(JSON.stringify(body.input)),peer=await this.appPeer(user.id,spaceId);
        const port:SdkPort={request:async(route,encoded)=>{const id=route.split('/')[4],op=route.split('/')[5];return JSON.stringify(!id?await this.sdk.submit(peer,JSON.parse(encoded!)):op==='start'?await this.sdk.start(peer,id):await this.sdk.status(peer,id));},write:async(ticket,input)=>this.jobs.writeInput(peer,ticket.ref.artifactId.slice(3),Buffer.from(input)),read:async ticket=>this.jobs.readOutput(peer,ticket.ref.artifactId.slice(4)),digest:async input=>hash(Buffer.from(input)),now:Date.now,wait:ms=>new Promise(resolve=>setTimeout(resolve,ms))};
        const client=new SchedulerSdk(port,{capacityWaitMs:0}),input=await client.registerInput(bytes,this.sdk.inputSchema(body.capability)),task=await client.submit({version:3,id:body.requestId,outputContract:this.sdk.outputSchema(body.capability),qualityTarget:'reference',nodes:[{id:'compute',capability:body.capability,input,parameters:'{}',dependsOn:[],...(body.targetId?{targetId:body.targetId}:{})}]},{requestId:body.requestId,budgetMs:30000,resultDestination:'ORIGIN'});
        res.json(await task.status());return;
      }
      if(action==='jobs'&&id&&method==='GET'){
        const peer=await this.appPeer(user.id,spaceId);
        if(parts[3]==='trace'){res.json(await this.jobs.trace(peer,id));return;}
        const result=await this.jobs.status(peer,id);let output=null;
        if(result.outputTicket){const d=this.artifacts.lookup(spaceId,result.outputTicket.ref);if(d)output=JSON.parse((await this.artifacts.readForControl(d)).toString());}
        res.json({...result,outputTicket:undefined,output});return;
      }
      res.status(404).json({error:'NOT_FOUND'});
    }catch(e){const code=e instanceof Error&&/^[A-Z][A-Z0-9_]{0,99}$/.test(e.message)?e.message:'REQUEST_FAILED',retryable=['NO_AVAILABLE_TARGET','NO_LEGAL_PLAN','ALLOTMENT_UNAVAILABLE','PLAN_STALE'].includes(code);res.status(code==='LOGIN_REQUIRED'?401:code.endsWith('FORBIDDEN')?403:retryable?409:400).json({error:code,retryable});}
  }
}
