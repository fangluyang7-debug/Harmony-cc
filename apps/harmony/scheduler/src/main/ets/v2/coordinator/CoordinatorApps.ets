import { util } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { CoordinatorDatabase, CoordinatorTransaction } from './CoordinatorDatabase';
import { CoordinatorPeer } from './CoordinatorCredentials';
import { CoordinatorCertificate } from './CoordinatorCertificate';
import { CoordinatorBudget } from './CoordinatorAllotments';
import { AppIdentityV2 } from '../protocol/SchedulingProtocolV2';
import { ResourceAmountV2 } from '../protocol/ResourcesV2';
import { AppDeclaration, validDeclaration } from './CoordinatorAppDeclaration';
import { hash, bytes } from '../platform/NativeTransport';
import { canonical } from '../core/CanonicalV2';

export interface CoordinatorAppInput {label:string;allowedContracts:string[];appId?:string;declaration?:AppDeclaration;}
interface AppQuota {maxConcurrent:number;resources:ResourceAmountV2[];}
export interface CoordinatorAppContext {identity:AppIdentityV2;declaration:AppDeclaration|null;offlineBase:ResourceAmountV2[];onlineExtra:ResourceAmountV2[];quota:AppQuota;deviceCapacity:ResourceAmountV2[];}
export interface CoordinatorAppInvite {version:number;registrationId:string;code:string;expiresAt:number;address:string;certificate:string;fingerprint:string;domain:string;appId:string;appInstanceId:string;holderInstanceId:string;}
export interface CoordinatorAppExchange {credential:string;peer:CoordinatorPeer;offlineBase:ResourceAmountV2[];onlineExtra:ResourceAmountV2[];quota:AppQuota;}
interface CredentialMetadata {peer:CoordinatorPeer;domain:string;expiresAt:number;}
function id(value:string):boolean{return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);}
function secret(length:number):string{return new util.Base64Helper().encodeToStringSync(cryptoFramework.createRandom().generateRandomSync(length).data).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
export class CoordinatorApps {
 private database:CoordinatorDatabase;private identity:CoordinatorCertificate;private address:string;
 constructor(database:CoordinatorDatabase,identity:CoordinatorCertificate,address:string){this.database=database;this.identity=identity;this.address=address;}
 async register(owner:CoordinatorPeer,input:CoordinatorAppInput):Promise<CoordinatorAppInvite>{
  if(owner.app)throw Error('DEVICE_OWNER_CREDENTIAL_REQUIRED');
  if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['label','allowedContracts','appId','declaration'].includes(k))||typeof input.label!=='string'||!input.label.trim()||input.label.length>80||
    !Array.isArray(input.allowedContracts)||!input.allowedContracts.length||input.allowedContracts.length>64||!input.allowedContracts.every(id)||new Set(input.allowedContracts).size!==input.allowedContracts.length||input.appId!==undefined&&!id(input.appId))throw Error('APP_DECLARATION_FIELDS_INVALID');
  if(input.declaration!==undefined&&!validDeclaration(input.declaration,input.allowedContracts))throw Error('APP_DECLARATION_INVALID');
  let appId=input.appId??util.generateRandomUUID(true);const instance=util.generateRandomUUID(true),holder=util.generateRandomUUID(true),code=secret(18),expiresAt=Date.now()+600000;
  await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{
   const budgetKey=JSON.stringify(['budget',owner.deviceId]),row=await tx.querySql('SELECT metadataJson FROM Device WHERE id=?',[budgetKey]);let budget:CoordinatorBudget|null=null;
   try{if(row.goToFirstRow())budget=JSON.parse(row.getString(0)) as CoordinatorBudget;}finally{row.close();}
   if(!budget||!budget.bindings.some(b=>b.groupId===owner.groupId&&b.holderInstanceId===owner.holderInstanceId&&b.appInstanceId===null))throw Error('IDENTITY_UNRESOLVED');
   const app=input.appId?await tx.querySql('SELECT id,groupId,principalId,contractsJson,declarationJson FROM RegisteredApp WHERE id=?',[input.appId]):await tx.querySql('SELECT id,groupId,principalId,contractsJson,declarationJson FROM RegisteredApp WHERE groupId=? AND principalId=? AND label=?',[owner.groupId,owner.principalId,input.label.trim()]);
   let exists=false;
   try{if(app.goToFirstRow()){
    exists=true;appId=app.getString(0);if(app.getString(1)!==owner.groupId||app.getString(2)!==owner.principalId)throw Error('APP_OWNER_REQUIRED');
    if(canonical(JSON.parse(app.getString(3)) as string[])!==canonical(input.allowedContracts))throw Error('APP_POLICY_CONFLICT');
    const declaration=app.getString(4);if(input.declaration&&declaration&&canonical(JSON.parse(declaration) as Object)!==canonical(input.declaration))throw Error('APP_DECLARATION_CONFLICT');
   }}finally{app.close();}
   if(input.appId&&!exists)throw Error('APP_UNKNOWN');
   if(!exists)await tx.executeSql('INSERT INTO RegisteredApp (id,groupId,principalId,label,contractsJson,resourcesJson,maxConcurrent,declarationJson) VALUES (?,?,?,?,?,?,64,?)',[appId,owner.groupId,owner.principalId,input.label.trim(),JSON.stringify(input.allowedContracts),JSON.stringify(budget.capacity),input.declaration?JSON.stringify(input.declaration):null]);
   else await tx.executeSql('UPDATE RegisteredApp SET maxConcurrent=64,resourcesJson=?,declarationJson=COALESCE(declarationJson,?) WHERE id=?',[JSON.stringify(budget.capacity),input.declaration?JSON.stringify(input.declaration):null,appId]);
   budget.bindings.push({groupId:owner.groupId,holderInstanceId:holder,appInstanceId:instance});
   await tx.executeSql('UPDATE Device SET revision=revision+1,metadataJson=? WHERE id=?',[JSON.stringify(budget),budgetKey]);
   await tx.executeSql("INSERT INTO RegisteredInstallation (id,appId,groupId,principalId,deviceId,holderInstanceId,state,secretHash,expiresAt,offlineJson,onlineJson) VALUES (?,?,?,?,?,?,'INVITED',?,?,?,?)",[instance,appId,owner.groupId,owner.principalId,owner.deviceId,holder,hash(bytes(code)),expiresAt,'[]',JSON.stringify(budget.capacity)]);
  });
  return {version:3,registrationId:instance,code,expiresAt,address:this.address,certificate:this.identity.certificate,fingerprint:this.identity.fingerprint,domain:'REAL',appId,appInstanceId:instance,holderInstanceId:holder};
 }
 async exchange(registrationId:string,code:string):Promise<CoordinatorAppExchange>{
  if(!id(registrationId)||typeof code!=='string'||!/^[A-Za-z0-9_-]{24}$/.test(code))throw Error('APP_INVITATION_INVALID');
  let result:CoordinatorAppExchange|null=null;
  await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{
   const rows=await tx.querySql('SELECT i.appId,i.groupId,i.principalId,i.deviceId,i.holderInstanceId,i.state,i.secretHash,i.expiresAt,i.offlineJson,i.onlineJson,a.contractsJson,a.resourcesJson,a.maxConcurrent FROM RegisteredInstallation i JOIN RegisteredApp a ON a.id=i.appId WHERE i.id=?',[registrationId]);
   try{
    if(!rows.goToFirstRow()||rows.getString(5)!=='INVITED'||rows.getLong(7)<=Date.now()||rows.getString(6)!==hash(bytes(code)))throw Error('APP_INVITATION_INVALID');
    const app:AppIdentityV2={appId:rows.getString(0),groupId:rows.getString(1),principalId:rows.getString(2),appInstanceId:registrationId,allowedContracts:JSON.parse(rows.getString(10)) as string[]};
    const peer:CoordinatorPeer={groupId:app.groupId,principalId:app.principalId,deviceId:rows.getString(3),holderInstanceId:rows.getString(4),credentialId:util.generateRandomUUID(true),app};
    const credential=secret(32),metadata:CredentialMetadata={peer,domain:'REAL',expiresAt:Date.now()+30*86400000};
    result={credential,peer,offlineBase:JSON.parse(rows.getString(8)) as ResourceAmountV2[],onlineExtra:JSON.parse(rows.getString(9)) as ResourceAmountV2[],quota:{maxConcurrent:rows.getLong(12),resources:JSON.parse(rows.getString(11)) as ResourceAmountV2[]}};
    await tx.executeSql('INSERT INTO Credential (id,groupId,holderInstanceId,tokenHash,revoked,revision,metadataJson) VALUES (?,?,?,?,0,1,?)',[peer.credentialId,peer.groupId,peer.holderInstanceId,hash(bytes(credential)),JSON.stringify(metadata)]);
   }finally{rows.close();}
   await tx.executeSql("UPDATE RegisteredInstallation SET state='ACTIVE',secretHash=NULL WHERE id=?",[registrationId]);
  });if(result===null)throw Error('APP_INVITATION_INVALID');return result;
 }
 async performance(peer:CoordinatorPeer):Promise<CoordinatorAppContext>{
  const context=await this.context(peer),capacity=context.deviceCapacity;
  if(!capacity.length)throw Error('IDENTITY_UNRESOLVED');
  const requested:ResourceAmountV2[]=[{resourcePoolId:'cpu',amount:64},{resourcePoolId:'ram',amount:68719476736},{resourcePoolId:'gpu',amount:8},{resourcePoolId:'vram',amount:68719476736}];
  const resources=requested.map((r:ResourceAmountV2):ResourceAmountV2=>({resourcePoolId:r.resourcePoolId,amount:Math.max(r.amount,context.quota.resources.find(v=>v.resourcePoolId===r.resourcePoolId)?.amount??0)}));
  resources.push(...context.quota.resources.filter(r=>!requested.some(v=>v.resourcePoolId===r.resourcePoolId)));
  const extra=capacity.map((r:ResourceAmountV2):ResourceAmountV2=>({resourcePoolId:r.resourcePoolId,amount:Math.max(0,r.amount-(context.offlineBase.find(v=>v.resourcePoolId===r.resourcePoolId)?.amount??0))}));
  await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{
   const row=await tx.querySql("SELECT state FROM RegisteredInstallation WHERE id=? AND holderInstanceId=? AND groupId=?",[context.identity.appInstanceId,peer.holderInstanceId,peer.groupId]);
   try{if(!row.goToFirstRow()||row.getString(0)!=='ACTIVE')throw Error('APP_CREDENTIAL_REVOKED');}finally{row.close();}
   await tx.executeSql('UPDATE RegisteredApp SET resourcesJson=?,maxConcurrent=? WHERE id=?',[JSON.stringify(resources),Math.max(32,context.quota.maxConcurrent),context.identity.appId]);
   await tx.executeSql('UPDATE RegisteredInstallation SET onlineJson=? WHERE id=?',[JSON.stringify(extra),context.identity.appInstanceId]);
  });return this.context(peer);
 }
 async context(peer:CoordinatorPeer):Promise<CoordinatorAppContext>{
  if(!peer.app)throw Error('APP_REGISTRATION_REQUIRED');let result:CoordinatorAppContext|null=null;
  await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{
   const rows=await tx.querySql('SELECT i.state,i.groupId,i.principalId,i.deviceId,i.holderInstanceId,i.appId,i.offlineJson,i.onlineJson,a.contractsJson,a.resourcesJson,a.maxConcurrent,a.declarationJson FROM RegisteredInstallation i JOIN RegisteredApp a ON a.id=i.appId WHERE i.id=?',[peer.app!.appInstanceId]);
   try{
    if(!rows.goToFirstRow()||rows.getString(0)!=='ACTIVE'||rows.getString(1)!==peer.groupId||rows.getString(2)!==peer.principalId||rows.getString(3)!==peer.deviceId||rows.getString(4)!==peer.holderInstanceId||rows.getString(5)!==peer.app!.appId)throw Error('APP_CREDENTIAL_REVOKED');
    const identity:AppIdentityV2={groupId:peer.groupId,principalId:peer.principalId,appId:rows.getString(5),appInstanceId:peer.app!.appInstanceId,allowedContracts:JSON.parse(rows.getString(8)) as string[]};
    result={identity,declaration:rows.getString(11)?JSON.parse(rows.getString(11)) as AppDeclaration:null,offlineBase:JSON.parse(rows.getString(6)) as ResourceAmountV2[],onlineExtra:JSON.parse(rows.getString(7)) as ResourceAmountV2[],quota:{resources:JSON.parse(rows.getString(9)) as ResourceAmountV2[],maxConcurrent:rows.getLong(10)},deviceCapacity:[]};
   }finally{rows.close();}
   const budget=await tx.querySql('SELECT metadataJson FROM Device WHERE id=?',[JSON.stringify(['budget',peer.deviceId])]);
   try{if(budget.goToFirstRow()&&result)result.deviceCapacity=(JSON.parse(budget.getString(0)) as CoordinatorBudget).capacity;}finally{budget.close();}
  });if(result===null)throw Error('APP_CREDENTIAL_REVOKED');return result;
 }
}
