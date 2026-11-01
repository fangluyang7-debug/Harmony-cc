import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {Prisma,PrismaClient} from '../generated/client';
import {AppIdentityV2,ResourceAmountV2,canonical,protocolId,validResourceVectorV2,vectorFitsV2,vectorSumV2} from '@harmony/scheduler-core';
import {Peer} from './channel';
import {PairingService,certificateFingerprint} from './auth';

export interface RegistrationInput {label:string;allowedContracts:string[];maxConcurrent:number;resources:ResourceAmountV2[];offlineBase:ResourceAmountV2[];onlineExtra:ResourceAmountV2[];appId?:string;}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const exact=(v:any,keys:string[],optional:string[]=[])=>v&&typeof v==='object'&&!Array.isArray(v)&&keys.every(k=>k in v)&&Object.keys(v).every(k=>[...keys,...optional].includes(k));
function validate(input:RegistrationInput){
 if(!exact(input,['label','allowedContracts','maxConcurrent','resources','offlineBase','onlineExtra'],['appId'])||typeof input.label!=='string'||!input.label.trim()||input.label.length>80||
  !Array.isArray(input.allowedContracts)||!input.allowedContracts.length||input.allowedContracts.length>64||!input.allowedContracts.every(protocolId)||new Set(input.allowedContracts).size!==input.allowedContracts.length||
  !Number.isSafeInteger(input.maxConcurrent)||input.maxConcurrent<1||input.maxConcurrent>64||![input.resources,input.offlineBase,input.onlineExtra].every(validResourceVectorV2)||
  !vectorFitsV2(vectorSumV2(input.offlineBase,input.onlineExtra),input.resources)||input.appId!==undefined&&!protocolId(input.appId))throw Error('APP_REGISTRATION_INVALID');
}
/** Explicit owner approval creates an installation capability; its label does not authenticate a software publisher. */
export class AppRegistry {
 constructor(private readonly db:PrismaClient,private readonly auth:PairingService,private readonly certificate:string,private readonly domain:string,private readonly now:()=>number=Date.now){}
 private async create(tx:Prisma.TransactionClient,owner:Peer,input:RegistrationInput,ids?:{appId:string;appInstanceId:string;holderInstanceId:string}){
  const existing=input.appId?await tx.registeredApp.findUnique({where:{id:input.appId}}):await tx.registeredApp.findUnique({where:{groupId_principalId_label:{groupId:owner.groupId,principalId:owner.principalId,label:input.label.trim()}}});
  if(existing&&(existing.groupId!==owner.groupId||existing.principalId!==owner.principalId))throw Error('APP_OWNER_REQUIRED');
  if(input.appId&&!existing)throw Error('APP_UNKNOWN');
  if(existing&&(canonical(JSON.parse(existing.contractsJson))!==canonical(input.allowedContracts)||existing.maxConcurrent!==input.maxConcurrent||canonical(JSON.parse(existing.resourcesJson))!==canonical(input.resources)))throw Error('APP_POLICY_CONFLICT');
  const app=existing??await tx.registeredApp.create({data:{id:ids?.appId??randomUUID(),groupId:owner.groupId,principalId:owner.principalId,label:input.label.trim(),contractsJson:JSON.stringify(input.allowedContracts),resourcesJson:JSON.stringify(input.resources),maxConcurrent:input.maxConcurrent}});
  const appBases=(await tx.registeredInstallation.findMany({where:{appId:app.id}})).map(i=>JSON.parse(i.offlineJson) as ResourceAmountV2[]);
  if(!vectorFitsV2(vectorSumV2(...appBases,input.offlineBase),input.resources))throw Error('APP_BASE_QUOTA_UNAVAILABLE');
  const id=ids?.appInstanceId??randomUUID(),holder=ids?.holderInstanceId??randomUUID(),code=randomBytes(18).toString('base64url');
  const budgetKey=JSON.stringify(['budget',owner.deviceId]),row=await tx.device.findUnique({where:{id:budgetKey}}),budget=row?JSON.parse(row.metadataJson):null;
  if(input.offlineBase.some(v=>v.amount>0)||input.onlineExtra.some(v=>v.amount>0)){
   if(!budget||!budget.bindings.some((b:any)=>b.groupId===owner.groupId&&b.holderInstanceId===owner.holderInstanceId&&b.appInstanceId===null))throw Error('IDENTITY_UNRESOLVED');
  }
  if(budget){
   const grants=(await tx.allotment.findMany()).filter(r=>r.id.startsWith('["allotment",')).map(r=>JSON.parse(r.metadataJson)).filter(r=>r.grant.deviceId===owner.deviceId);
   const unmaterialized=(await tx.registeredInstallation.findMany({where:{deviceId:owner.deviceId}})).filter(i=>!grants.some(g=>g.grant.holderInstanceId===i.holderInstanceId)).map(i=>JSON.parse(i.offlineJson) as ResourceAmountV2[]);
   if(!vectorFitsV2(vectorSumV2(...grants.map(g=>g.reserved),...unmaterialized,input.offlineBase),budget.capacity))throw Error('APP_BASE_BUDGET_UNAVAILABLE');
   budget.bindings.push({groupId:owner.groupId,holderInstanceId:holder,appInstanceId:id});
   await tx.device.update({where:{id:budgetKey},data:{revision:{increment:1},metadataJson:JSON.stringify(budget)}});
  }
  const installation=await tx.registeredInstallation.create({data:{id,appId:app.id,groupId:owner.groupId,principalId:owner.principalId,deviceId:owner.deviceId,holderInstanceId:holder,state:'INVITED',secretHash:hash(code),expiresAt:this.now()+600000,offlineJson:JSON.stringify(input.offlineBase),onlineJson:JSON.stringify(input.onlineExtra)}});
  return {app,installation,code};
 }
 async register(owner:Peer,input:RegistrationInput,address:string){
  if(owner.app)throw Error('DEVICE_OWNER_CREDENTIAL_REQUIRED');validate(input);
  const url=new URL(address);if(url.protocol!=='https:'||url.pathname!=='/'||url.username||url.password||url.hash||url.search)throw Error('APP_ADDRESS_INVALID');
  const {app,installation,code}=await this.db.$transaction(tx=>this.create(tx,owner,input));
  return {version:3,registrationId:installation.id,code,expiresAt:installation.expiresAt,address:url.origin,certificate:this.certificate,fingerprint:certificateFingerprint(this.certificate),domain:this.domain,appId:app.id,appInstanceId:installation.id,holderInstanceId:installation.holderInstanceId};
 }
 private identity(app:{id:string;groupId:string;principalId:string;contractsJson:string},instanceId:string):AppIdentityV2{return {groupId:app.groupId,principalId:app.principalId,appId:app.id,appInstanceId:instanceId,allowedContracts:JSON.parse(app.contractsJson)};}
 private async activate(tx:Prisma.TransactionClient,id:string){
  const i=await tx.registeredInstallation.findUniqueOrThrow({where:{id}}),app=await tx.registeredApp.findUniqueOrThrow({where:{id:i.appId}}),credential=randomBytes(32).toString('base64url');
  const peer:Peer={groupId:i.groupId,principalId:i.principalId,deviceId:i.deviceId,holderInstanceId:i.holderInstanceId,credentialId:randomUUID(),app:this.identity(app,i.id)};
  await tx.credential.create({data:{id:peer.credentialId,groupId:i.groupId,holderInstanceId:i.holderInstanceId,tokenHash:hash(credential),revision:1,metadataJson:JSON.stringify({peer,domain:this.domain,expiresAt:this.now()+30*86400000})}});
  await tx.registeredInstallation.update({where:{id},data:{state:'ACTIVE',secretHash:null}});
  return {credential,peer,offlineBase:JSON.parse(i.offlineJson) as ResourceAmountV2[],onlineExtra:JSON.parse(i.onlineJson) as ResourceAmountV2[],quota:{maxConcurrent:app.maxConcurrent,resources:JSON.parse(app.resourcesJson) as ResourceAmountV2[]}};
 }
 async exchange(input:{registrationId:string;code:string}){
  if(!exact(input,['registrationId','code'])||!protocolId(input.registrationId)||typeof input.code!=='string'||!/^[A-Za-z0-9_-]{24}$/.test(input.code))throw Error('APP_INVITATION_INVALID');
  return this.db.$transaction(async tx=>{const i=await tx.registeredInstallation.findUnique({where:{id:input.registrationId}});if(!i||i.state!=='INVITED'||i.expiresAt<=this.now()||i.secretHash!==hash(input.code))throw Error('APP_INVITATION_INVALID');const changed=await tx.registeredInstallation.updateMany({where:{id:i.id,state:'INVITED',secretHash:i.secretHash},data:{state:'EXCHANGING',secretHash:null}});if(changed.count!==1)throw Error('APP_INVITATION_INVALID');return this.activate(tx,i.id);});
 }
 async context(peer:Peer,tx:Prisma.TransactionClient|PrismaClient=this.db){
  if(!peer.app)throw Error('APP_REGISTRATION_REQUIRED');
  const i=await tx.registeredInstallation.findUnique({where:{id:peer.app.appInstanceId}}),app=i?await tx.registeredApp.findUnique({where:{id:i.appId}}):null;
  if(!i||!app||i.state!=='ACTIVE'||i.groupId!==peer.groupId||i.principalId!==peer.principalId||i.deviceId!==peer.deviceId||i.holderInstanceId!==peer.holderInstanceId||app.id!==peer.app.appId)throw Error('APP_CREDENTIAL_REVOKED');
  return {identity:this.identity(app,i.id),offlineBase:JSON.parse(i.offlineJson) as ResourceAmountV2[],onlineExtra:JSON.parse(i.onlineJson) as ResourceAmountV2[],quota:{maxConcurrent:app.maxConcurrent,resources:JSON.parse(app.resourcesJson) as ResourceAmountV2[]}};
 }
 async reserveJob(tx:Prisma.TransactionClient,peer:Peer,id:string,resources:ResourceAmountV2[],deadlineAt:number){
  const context=await this.context(peer,tx),existing=await tx.appJobReservation.findUnique({where:{id}});
  if(existing&&(existing.appInstanceId!==context.identity.appInstanceId||existing.appId!==context.identity.appId))throw Error('JOB_SCOPE');
  const rows=await tx.appJobReservation.findMany({where:{groupId:peer.groupId,principalId:peer.principalId,appId:context.identity.appId}}),active:ResourceAmountV2[][]=[];
  for(const row of rows){if(row.id===id)continue;const attempt=await tx.attempt.findUnique({where:{id:row.id}}),job=await tx.cpuJob.findUnique({where:{id:row.id}});
   if(attempt){if(attempt.state!=='REJECTED'&&!(attempt.recordJson&&JSON.parse(attempt.recordJson).resourcesSettled))active.push(JSON.parse(row.resourcesJson));}
   else if(job&&['WAITING_INPUT','DISPATCHING'].includes(job.state)&&row.deadlineAt>this.now())active.push(JSON.parse(row.resourcesJson));
  }
  if(active.length>=context.quota.maxConcurrent||!vectorFitsV2(vectorSumV2(...active,resources),context.quota.resources))throw Error('APP_QUOTA_EXCEEDED');
  if(existing)await tx.appJobReservation.update({where:{id},data:{resourcesJson:JSON.stringify(resources),deadlineAt}});
  else await tx.appJobReservation.create({data:{id,groupId:peer.groupId,principalId:peer.principalId,appId:context.identity.appId,appInstanceId:context.identity.appInstanceId,resourcesJson:JSON.stringify(resources),deadlineAt}});
 }
 async revoke(owner:Peer,id:string){
  if(owner.app)throw Error('DEVICE_OWNER_CREDENTIAL_REQUIRED');const i=await this.db.registeredInstallation.findUnique({where:{id}});
  if(!i||i.groupId!==owner.groupId||i.principalId!==owner.principalId)throw Error('APP_OWNER_REQUIRED');
  await this.db.registeredInstallation.update({where:{id},data:{state:'REVOKED',secretHash:null}});
  for(const c of await this.db.credential.findMany({where:{groupId:i.groupId,holderInstanceId:i.holderInstanceId,revoked:false}}))await this.auth.revoke(c.id);
  // Base reservations survive revocation: an offline installation has not acknowledged release.
  return {revoked:true,baseRelease:'PENDING_RECONCILIATION'};
 }
 async list(owner:Peer){return this.db.registeredInstallation.findMany({where:{groupId:owner.groupId,principalId:owner.principalId},select:{id:true,appId:true,deviceId:true,holderInstanceId:true,state:true,offlineJson:true,onlineJson:true}});}
 /** A browser's authenticated submit action confirms its zero-local-quota installation. */
 async console(owner:Peer,contracts:string[],resources:ResourceAmountV2[]):Promise<Peer>{
  return this.db.$transaction(async tx=>{
   const key={groupId:owner.groupId,principalId:owner.principalId,holderInstanceId:owner.holderInstanceId};
   let mapping=await tx.consoleApp.findUnique({where:{groupId_principalId_holderInstanceId:key}});
   if(!mapping)mapping=await tx.consoleApp.create({data:{id:randomUUID(),...key,appId:randomUUID(),appInstanceId:randomUUID()}});
   const existing=await tx.registeredInstallation.findUnique({where:{id:mapping.appInstanceId}});
   if(existing){if(existing.state!=='ACTIVE')throw Error('APP_CREDENTIAL_REVOKED');const app=await tx.registeredApp.findUniqueOrThrow({where:{id:existing.appId}}),credential=await tx.credential.findFirst({where:{groupId:owner.groupId,holderInstanceId:existing.holderInstanceId,revoked:false}});if(!credential)throw Error('APP_CREDENTIAL_REVOKED');return {...owner,credentialId:credential.id,app:this.identity(app,existing.id)};}
   await this.create(tx,owner,{label:'浏览器控制台',allowedContracts:contracts,maxConcurrent:4,resources,offlineBase:[],onlineExtra:[]},{appId:mapping.appId,appInstanceId:mapping.appInstanceId,holderInstanceId:owner.holderInstanceId});
   return (await this.activate(tx,mapping.appInstanceId)).peer;
  });
 }
}
