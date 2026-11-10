import {PhotoRuns} from './photo-runs';
import {recentJobs} from './dashboard-history';
import {retryableJobError} from './job-errors';
import { SpaceEvents } from './space-events';
import { createHash, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
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
import {TelemetryView} from './telemetry-view';
import {deviceMembershipActive,registerDeviceMembership} from './device-membership';

const qrCode=require('qrcode') as {toDataURL:(text:string,options:object)=>Promise<string>};
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const passwordHash=(password:string,salt:string)=>new Promise<Buffer>((resolve,reject)=>scrypt(password,salt,64,(e,v)=>e?reject(e):resolve(v)));
function label(v:unknown,max=60){if(typeof v!=='string'||!v.trim()||v.trim().length>max)throw Error('INPUT_INVALID');return v.trim();}
const MiB=1048576,GiB=1073741824,TiB=1099511627776;
export interface Contribution {ownerMode:string;maxCpuThreads:number;maxMemoryBytes:number;reserveMemoryBytes:number;maxVramBytes?:number;capacityMode?:'auto';}
export function contribution(v:any):Contribution{
  if(!v||!['dedicated','windows-idle','paused'].includes(v.ownerMode)||!Number.isInteger(v.maxCpuThreads)||v.maxCpuThreads<1||v.maxCpuThreads>256||!Number.isSafeInteger(v.maxMemoryBytes)||v.maxMemoryBytes<67108864||v.maxMemoryBytes>1099511627776||!Number.isSafeInteger(v.reserveMemoryBytes)||v.reserveMemoryBytes<0||v.reserveMemoryBytes>1099511627776)throw Error('CONTRIBUTION_INVALID');
  if(v.maxVramBytes!==undefined&&(!Number.isSafeInteger(v.maxVramBytes)||v.maxVramBytes<0||v.maxVramBytes>1099511627776))throw Error('CONTRIBUTION_INVALID');
  if(v.capacityMode!==undefined&&!['auto','fixed'].includes(v.capacityMode))throw Error('CONTRIBUTION_INVALID');
  return {...(v.maxVramBytes?{maxVramBytes:v.maxVramBytes}:{}),...(v.capacityMode==='auto'?{capacityMode:'auto' as const}:{}),ownerMode:v.ownerMode,maxCpuThreads:v.maxCpuThreads,maxMemoryBytes:v.maxMemoryBytes,reserveMemoryBytes:v.reserveMemoryBytes};
}
export function capacityVector(settings:Contribution){
  return [{resourcePoolId:'cpu',amount:settings.maxCpuThreads},{resourcePoolId:'ram',amount:settings.maxMemoryBytes},...(settings.maxVramBytes?[{resourcePoolId:'gpu',amount:1},{resourcePoolId:'vram',amount:settings.maxVramBytes}]:[])];
}
/** What a paired device measured about itself. Either field may be unknown; neither is trusted beyond its own device. */
export interface MeasuredCapacity {cpuThreads:number|null;totalMemoryBytes:number|null;}
export function measuredCapacity(v:any):MeasuredCapacity{
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['cpuThreads','totalMemoryBytes'].includes(k)))throw Error('MEASUREMENT_INVALID');
  const cpu=v.cpuThreads??null,ram=v.totalMemoryBytes??null;
  if(cpu!==null&&(!Number.isInteger(cpu)||cpu<1||cpu>1024)||ram!==null&&(!Number.isSafeInteger(ram)||ram<64*MiB||ram>64*TiB))throw Error('MEASUREMENT_INVALID');
  return {cpuThreads:cpu,totalMemoryBytes:ram};
}
/**
 * Automatic ceiling for a device that reported its hardware. The device keeps the larger of 1 GiB or a
 * quarter of its RAM for the system and the owner's own apps; the remainder (rounded down to 64 MiB) is
 * the contribution ceiling. CPU contributes half of the hardware threads, at least one. Storage capacity
 * is deliberately not part of this: only RAM backs task execution. Unknown measurements keep the current value.
 */
export function autoContribution(current:Contribution,measured:MeasuredCapacity):Contribution{
  const next:Contribution={...current,capacityMode:'auto'};
  if(measured.totalMemoryBytes!==null){
    const reserve=Math.min(TiB,Math.max(GiB,Math.ceil(measured.totalMemoryBytes/4/MiB)*MiB));
    next.reserveMemoryBytes=reserve;
    next.maxMemoryBytes=Math.min(TiB,Math.max(64*MiB,Math.floor((measured.totalMemoryBytes-reserve)/(64*MiB))*64*MiB));
  }
  if(measured.cpuThreads!==null)next.maxCpuThreads=Math.min(64,Math.max(1,Math.floor(measured.cpuThreads/2)));
  return next;
}

/** Browser accounts and room membership are separate from device execution credentials. */
export class TeamSpaces {
  private photoRuns:PhotoRuns|undefined;
  /** App-authenticated display records. Execution remains in /v2/sdk/jobs. */
  async appPhoto(peer:Peer,request:{route:string;method?:string;body?:any;data?:string}){
    const context=await this.apps.context(peer),appId=context.identity.appInstanceId;
    if(!peer.app||!['photo.analyze.v1','photo.prepare.v1','photo.enhance.v1','photo.assemble.v1','photo.deliver.v1'].every(c=>context.identity.allowedContracts.includes(c)))throw Error('PHOTO_APP_REQUIRED');
    const url=new URL(request.route,'https://photo.invalid'),method=request.method??'GET',parts=url.pathname.split('/').filter(Boolean);
    if(url.origin!=='https://photo.invalid'||parts[0]!=='photo-runs'||parts.length>3||!['GET','POST','PUT'].includes(method))throw Error('PHOTO_ROUTE_INVALID');
    const photo=this.photoRuns??(this.photoRuns=new PhotoRuns(this.config.dataDir,this.db,this.config.domain)),group=peer.groupId,user=peer.principalId,id=parts[1];
    if(id==='directory'&&method==='GET')return {space:await this.db.teamSpace.findUnique({where:{id:group},select:{id:true,name:true}}),devices:await this.db.spaceDevice.findMany({where:{spaceId:group},select:{id:true,name:true}})};
    if(!id){
      if(method==='GET')return (await photo.list(group)).filter(r=>r.appInstanceId===appId);
      if(method==='POST'){if(!['LOCAL','COOPERATIVE'].includes(request.body?.mode))throw Error('PHOTO_RUN_INVALID');return photo.create(group,user,{...request.body,sourceDeviceId:peer.deviceId},appId);}
      throw Error('PHOTO_ROUTE_INVALID');
    }
    const run=await photo.read(group,id);if(run.appInstanceId!==appId||run.userId!==user||run.sourceDeviceId!==peer.deviceId)throw Error('PHOTO_APP_SCOPE');
    if(parts.length===2){if(method==='GET')return photo.view(group,id);if(method==='POST')return photo.update(group,id,user,request.body);}
    const index=Number(url.searchParams.get('image'));if(!url.searchParams.has('image')||!Number.isInteger(index)||index<0||index>=run.inputs.length)throw Error('PHOTO_RUN_INVALID');
    if(parts[2]==='input'){
      if(method==='PUT'){if(typeof request.data!=='string'||request.data.length>11184812)throw Error('PHOTO_INPUT_INVALID');await photo.preview(group,id,user,index,Buffer.from(request.data,'base64'));return {uploaded:true};}
      if(method==='GET')return {mime:'image/png',data:(await photo.input(group,id,index)).toString('base64')};
    }
    if(parts[2]==='capture-result'&&method==='POST'){
      const job=run.jobs.find((j:any)=>j.imageIndex===index);if(!job)throw Error('PHOTO_JOB_SCOPE');
      const output=await this.sdk.readOutput(peer,job.id);await photo.retainResult(group,user,job.id,output);return {retained:true};
    }
    if(parts[2]==='result'&&method==='GET')return JSON.parse((await photo.result(group,id,index)).toString());
    throw Error('PHOTO_ROUTE_INVALID');
  }
  private readonly streams=new Map<()=>void,string>();
  close(){for(const close of this.streams.keys())close();}
  private readonly authAttempts=new Map<string,{count:number;until:number}>();
  constructor(private readonly db:PrismaClient,private readonly auth:PairingService,private readonly allotments:AllotmentIssuer,
    private readonly directory:DeviceDirectory,private readonly jobs:CpuJobs,private readonly artifacts:ArtifactChannel,
    private readonly config:CoordinatorConfig,private readonly status:()=>{ready:boolean;epoch:number},private readonly snapshots:SnapshotBuilder,private readonly events:SpaceEvents,private readonly apps:AppRegistry,private readonly sdk:SdkJobs,private readonly networkView?:(groupId:string)=>Promise<unknown>,private readonly telemetry?:TelemetryView){}
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
  private appPeer(userId:string,spaceId:string,confirmCapabilities=false){return this.apps.console(this.peer(userId,spaceId),this.sdk.contractIds(),[{resourcePoolId:'cpu',amount:4},{resourcePoolId:'ram',amount:1073741824},{resourcePoolId:'gpu',amount:1},{resourcePoolId:'vram',amount:8589934592}],confirmCapabilities);}
  private async sourceAppPeer(userId:string,spaceId:string,source:string,confirm=false){
    if(!source)return this.appPeer(userId,spaceId,confirm);
    const device=await this.db.spaceDevice.findUnique({where:{id:source}});
    if(!device||device.spaceId!==spaceId||device.userId!==userId||!await deviceMembershipActive(this.db,source))throw Error('PHOTO_SOURCE_SCOPE');
    const peer={...this.peer(userId,spaceId),deviceId:source,holderInstanceId:'photo-source-'+source};
    return this.apps.console(peer,this.sdk.contractIds(),[{resourcePoolId:'cpu',amount:4},{resourcePoolId:'ram',amount:1073741824},{resourcePoolId:'gpu',amount:1},{resourcePoolId:'vram',amount:8589934592}],confirm);
  }
  /** Devices poll their settings; an auto-capacity device also reports its hardware so the ceiling follows the real machine. */
  async deviceSettings(peer:Peer,measured?:MeasuredCapacity):Promise<Contribution|null>{
    const d=await this.db.spaceDevice.findUnique({where:{id:peer.deviceId}});
    if(!d||d.spaceId!==peer.groupId||d.holderId!==peer.holderInstanceId)return null;
    const settings=JSON.parse(d.settingsJson) as Contribution;
    if(!measured||settings.capacityMode!=='auto')return settings;
    const next=autoContribution(settings,measured);
    if(next.maxCpuThreads===settings.maxCpuThreads&&next.maxMemoryBytes===settings.maxMemoryBytes&&next.reserveMemoryBytes===settings.reserveMemoryBytes)return settings;
    const budget=await this.allotments.budget(d.id);
    try{await this.allotments.confirmDevice(d.id,capacityVector(next),budget?.bindings??[{groupId:d.spaceId,holderInstanceId:d.holderId,appInstanceId:null}]);}
    catch(error){
      // Shrinking below what is already reserved waits until those reservations settle; the old ceiling stays.
      if(error instanceof Error&&['BUDGET_RECONCILIATION_REQUIRED','BINDING_HAS_UNSETTLED_RESERVATION'].includes(error.message))return settings;
      throw error;
    }
    await this.db.spaceDevice.update({where:{id:d.id},data:{settingsJson:JSON.stringify(next)}});
    this.events.changed(d.spaceId);
    return next;
  }
  async dashboard(userId:string,spaceId:string){
    const me=await this.member(userId,spaceId),space=await this.db.teamSpace.findUniqueOrThrow({where:{id:spaceId}}),now=Date.now();
    const [members,users,registered,profiles,states,rows]=await Promise.all([
      this.db.spaceMember.findMany({where:{spaceId}}),this.db.spaceUser.findMany({where:{id:{in:(await this.db.spaceMember.findMany({where:{spaceId}})).map(m=>m.userId)}},select:{id:true,name:true}}),
      this.db.spaceDevice.findMany({where:{spaceId}}),this.directory.profiles(spaceId),this.db.capabilityState.findMany({where:{groupId:spaceId}}),
      recentJobs(this.db,spaceId)]);
    const attempts=await this.db.attempt.findMany({where:{groupId:spaceId,id:{in:rows.map(r=>r.id)}}});
    let available:string[]=[];try{const s=await this.snapshots.build(spaceId);available=s.policy.revoked?[]:s.snapshot.candidates.filter(c=>(!c.availability||c.availability.reason==='AVAILABLE')&&s.policy.allowedTargetIds.includes(c.targetId)&&c.observedAt+c.ttlMs>now).map(c=>c.targetId);}catch{}
    const active=await Promise.all(registered.map(d=>deviceMembershipActive(this.db,d.id)));
    const devices=registered.filter((_,i)=>active[i]).map(d=>{const p=profiles.find(p=>p.deviceId===d.id),sample=p?.ownerActivity;
      const online=!!sample&&sample.sampledAt+sample.ttlMs>now;
      return {id:d.id,name:d.name,userId:d.userId,online,lastSeen:sample?.sampledAt??null,settings:JSON.parse(d.settingsJson),profile:p??null,
        capabilities:(p?.executors??[]).map(e=>{const state=JSON.parse(states.find(s=>s.id===JSON.stringify([spaceId,p!.holderInstanceId,e.target.targetId]))?.metadataJson??'{"state":"DISCOVERED"}').state;
          return {capability:e.contract.capability,targetId:e.target.targetId,backend:e.target.backend,available:online&&available.includes(e.target.targetId)&&['ACTIVE','CANARY'].includes(state),state};})};});
    return {space,me,members:members.map(m=>({...m,name:users.find(u=>u.id===m.userId)?.name??'成员'})),devices,network:await this.networkView?.(spaceId)??[],
      jobs:rows.map(r=>{const d=JSON.parse(r.metadataJson);return {id:r.id,createdAt:Number.isFinite(d.request?.now)?d.request.now:null,userId:r.principalId,state:attempts.find(a=>a.id===r.id)?.state??r.state,deviceId:d.offer.target.deviceId,capability:d.offer.task.contract.capability,reason:d.offer.reasonCode,rejection:attempts.find(a=>a.id===r.id)?.rejectionJson?JSON.parse(attempts.find(a=>a.id===r.id)!.rejectionJson!):null};}).sort((a,b)=>(b.createdAt??0)-(a.createdAt??0)||a.id.localeCompare(b.id)).slice(0,100),
      coordinator:{...this.status(),location:this.config.proxy&&this.config.publicUrl&&!['localhost','127.0.0.1','[::1]'].includes(new URL(this.config.publicUrl).hostname)?'CLOUD':'LOCAL_DEVELOPMENT',domain:this.config.domain,address:this.config.publicUrl??null},updatedAt:now};
  }
  private stream(req:any,res:any,spaceId:string,sessionId:string){
    res.status(200).set({'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});
    res.flushHeaders();let closed=false,busy=false,dirty=true,hintTimer:NodeJS.Timeout|undefined;
    const schedule=()=>{if(!hintTimer&&!closed){hintTimer=setTimeout(()=>{hintTimer=undefined;void send();},250);hintTimer.unref();}};
    const stop=()=>{if(closed)return;closed=true;clearInterval(timer);if(hintTimer)clearTimeout(hintTimer);unsubscribe();this.streams.delete(stop);res.end();};
    const send=async()=>{
      if(closed||busy)return;busy=true;
      try{
        const {user}=await this.session(req.headers.cookie);await this.member(user.id,spaceId);
        if(closed)return;
        const text=dirty?'event: changed\ndata: {}\n\n':': heartbeat\n\n';dirty=false;
        if(!res.write(text))stop();
      }catch{stop();}finally{busy=false;if(dirty&&!closed)schedule();}
    };
    const unsubscribe=this.events.subscribe(spaceId,()=>{dirty=true;schedule();});
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
        const raw=label(body.code,80),digits=raw.replace(/[\s-]/g,''),code=/^\d{8}$/.test(digits)?digits:raw,invite=await this.db.spaceInvite.findUnique({where:{id:hash(code)}});
        if(!invite||invite.revoked||invite.expiresAt<=Date.now())throw Error('INVITE_EXPIRED');
        await this.db.spaceMember.upsert({where:{spaceId_userId:{spaceId:invite.spaceId,userId:user.id}},create:{id:randomUUID(),spaceId:invite.spaceId,userId:user.id,role:invite.role,joinedAt:Date.now()},update:{}});this.events.changed(invite.spaceId);res.json({id:invite.spaceId});return;
      }
      const parts=route.split('/').filter(Boolean),[spaceId,action,id]=parts;
      const member=await this.member(user.id,spaceId);
      if(action==='events'&&parts.length===2&&method==='GET'){this.stream(req,res,spaceId,session.id);return;}
      if(action==='telemetry'&&this.telemetry&&method==='GET'){
        if(parts.length===2){res.json({...await this.telemetry.snapshot(spaceId,user.id),coordinator:{...this.status(),domain:this.config.domain,address:this.config.publicUrl??null}});return;}
        if(parts.length===4&&parts[2]==='traces'){res.json(await this.telemetry.trace(this.peer(user.id,spaceId),parts[3]));return;}
      }
      if(parts.length===1&&method==='GET'){res.json(await this.dashboard(user.id,spaceId));return;}
      if(action==='invites'&&method==='POST'){
        await this.member(user.id,spaceId,['OWNER']);if(!['MEMBER','VIEWER'].includes(body.role))throw Error('ROLE_INVALID');
        const code=randomBytes(18).toString('base64url'),expiresAt=Date.now()+86400000;
        // Keep QR/full-link tokens compatible; the numeric alias is scoped to this coordinator.
        for(let attempt=0;attempt<8;attempt++){
          const shortCode=String(randomInt(10000000,100000000));
          try{
            await this.db.$transaction([this.db.spaceInvite.create({data:{id:hash(code),spaceId,role:body.role,expiresAt}}),this.db.spaceInvite.create({data:{id:hash(shortCode),spaceId,role:body.role,expiresAt}})]);
            res.json({code,shortCode,expiresAt,address:this.config.publicUrl??'',fingerprint:this.config.proxy?'':this.auth.publicFingerprint()});return;
          }catch(error){if((error as {code?:string}).code!=='P2002'||attempt===7)throw error;}
        }
      }
      if(action==='members'&&method==='POST'){
        await this.member(user.id,spaceId,['OWNER']);if(!['MEMBER','VIEWER'].includes(body.role))throw Error('ROLE_INVALID');
        const target=await this.member(id,spaceId);if(target.role==='OWNER')throw Error('OWNER_ROLE_FIXED');
        await this.db.spaceMember.update({where:{id:target.id},data:{role:body.role}});res.json({ok:true});return;
      }
      if(action==='devices'&&method==='POST'){
        await this.member(user.id,spaceId,['OWNER','MEMBER']);const settings=contribution(body.settings);
        if(id){const d=await this.db.spaceDevice.findUniqueOrThrow({where:{id}});if(d.spaceId!==spaceId||d.userId!==user.id&&member.role!=='OWNER')throw Error('DEVICE_FORBIDDEN');
          const initial=JSON.parse(d.settingsJson);if(settings.maxCpuThreads!==initial.maxCpuThreads||settings.maxMemoryBytes!==initial.maxMemoryBytes||(settings.maxVramBytes??0)!==(initial.maxVramBytes??0))throw Error('CAPACITY_REPAIR_REQUIRED');
          await this.db.spaceDevice.update({where:{id},data:{settingsJson:JSON.stringify(settings)}});res.json({ok:true});return;}
        const address=this.config.publicUrl;if(!address)throw Error('PUBLIC_URL_REQUIRED');
        const deviceId=randomUUID(),holderId=randomUUID();
        await this.allotments.confirmDevice(deviceId,capacityVector(settings),[{groupId:spaceId,holderInstanceId:holderId,appInstanceId:null}]);
        const invitation=await this.auth.invite(spaceId,user.id,deviceId,address,600000);
        await this.db.$transaction(async tx=>{
          await tx.spaceDevice.create({data:{id:deviceId,spaceId,userId:user.id,holderId,name:label(body.name),settingsJson:JSON.stringify(settings),createdAt:Date.now()}});
          if(body.installationId)await registerDeviceMembership(tx,body.installationId,deviceId,body.previousDeviceId,user.id,body.knownDeviceIds??[]);
        });
        const bootstrap={invitation:{...invitation,tlsMode:this.config.proxy?'public':'pinned'},holderInstanceId:holderId,domain:this.config.domain,contribution:settings};
        const qrPayload=body.qrFormat==='link'&&!this.config.proxy
          ? invitation.address+'/#device='+invitation.inviteId+'.'+invitation.code+'&pin='+invitation.fingerprint
          : JSON.stringify(bootstrap);
        const qr=await qrCode.toDataURL(qrPayload,{errorCorrectionLevel:'L',margin:4,width:640});
        res.json({...bootstrap,qr});return;
      }
      if(action==='photo-runs'){
        if(id==='directory'&&method==='GET'){
          const [space,devices]=await Promise.all([this.db.teamSpace.findUnique({where:{id:spaceId},select:{id:true,name:true}}),this.db.spaceDevice.findMany({where:{spaceId},select:{id:true,name:true}})]);
          res.json({space,devices});return;
        }
        const photo=this.photoRuns??(this.photoRuns=new PhotoRuns(this.config.dataDir,this.db,this.config.domain));
        if(method==='GET'){if(id&&parts[3]==='input'){res.type('image/png').send(await photo.input(spaceId,id,Number(req.query.image??0)));return;}if(id&&parts[3]==='result'){res.type('application/json').send(await photo.result(spaceId,id,Number(req.query.image??0)));return;}res.json(id?await photo.view(spaceId,id):await photo.list(spaceId));return;}
        await this.member(user.id,spaceId,['OWNER','MEMBER']);
        if(method==='PUT'&&id&&parts[3]==='input'){if(!Buffer.isBuffer(body))throw Error('BINARY_INPUT_REQUIRED');await photo.preview(spaceId,id,user.id,Number(req.query.image),body);res.json({uploaded:true});return;}
        if(method==='POST'){res.json(id?await photo.update(spaceId,id,user.id,body):await photo.create(spaceId,user.id,body));return;}
      }
      if(action==='sdk'&&parts[2]==='jobs'){
        await this.member(user.id,spaceId,['OWNER','MEMBER']);const jobId=parts[3],operation=parts[4],peer=await this.sourceAppPeer(user.id,spaceId,String(req.query.source??''),!jobId&&method==='POST');
        if(!jobId&&method==='POST'){res.json(await this.sdk.submit(peer,body));return;}
        if(jobId&&method==='PUT'&&operation==='input'){if(!Buffer.isBuffer(body))throw Error('BINARY_INPUT_REQUIRED');await this.sdk.writeInput(peer,jobId,String(req.query.artifact??''),body);await this.photoRuns?.retainInput(spaceId,user.id,body);res.json({uploaded:true});return;}
        if(jobId&&method==='GET'&&operation==='output'){const output=await this.sdk.readOutput(peer,jobId);await this.photoRuns?.retainResult(spaceId,user.id,jobId,output);res.type('application/octet-stream').send(output);return;}
        if(jobId&&method==='POST'&&operation==='start'){res.json(await this.sdk.start(peer,jobId));return;}
        if(jobId&&method==='POST'&&operation==='cancel'){res.json(await this.sdk.cancel(peer,jobId));return;}
        if(jobId&&method==='POST'&&operation==='received'){res.json(await this.sdk.received(peer,jobId,body));return;}
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
    }catch(e){const code=e instanceof Error&&/^[A-Z][A-Z0-9_]{0,99}$/.test(e.message)?e.message:'REQUEST_FAILED',retryable=retryableJobError(code);
      // Preserve a database failure code for diagnostics without logging query
      // arguments, credentials or task payloads. The public error stays bounded.
      const databaseCode=(e as {code?:unknown})?.code;
      if(code==='REQUEST_FAILED'&&typeof databaseCode==='string'&&/^P[0-9]{4}$/.test(databaseCode))console.warn('SPACE_STORAGE_ERROR '+databaseCode);
      if(code==='REQUEST_FAILED'&&e instanceof Error)console.warn('SPACE_REQUEST_ERROR '+e.name+' '+(e.stack?.split('\n').slice(1,4).join(' ')??''));
      res.status(code==='LOGIN_REQUIRED'?401:code.endsWith('FORBIDDEN')?403:retryable?409:400).json({error:code,message:code,retryable});}
  }
}
