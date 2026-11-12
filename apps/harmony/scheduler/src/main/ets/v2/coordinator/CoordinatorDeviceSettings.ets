import { CoordinatorDatabase, CoordinatorTransaction } from './CoordinatorDatabase';
import { CoordinatorAllotments } from './CoordinatorAllotments';
import { CoordinatorPeer } from './CoordinatorCredentials';
import { ResourceAmountV2 } from '../protocol/ResourcesV2';
export interface CoordinatorContribution {ownerMode:string;maxCpuThreads:number;maxMemoryBytes:number;reserveMemoryBytes:number;maxVramBytes?:number;capacityMode?:string;}
export interface CoordinatorMeasuredCapacity {cpuThreads:number|null;totalMemoryBytes:number|null;vramBytes?:number|null;}
const MiB=1048576,TiB=1099511627776;
export function coordinatorAutoContribution(current:CoordinatorContribution,measured:CoordinatorMeasuredCapacity):CoordinatorContribution{
 const next:CoordinatorContribution={ownerMode:current.ownerMode,maxCpuThreads:current.maxCpuThreads,maxMemoryBytes:current.maxMemoryBytes,reserveMemoryBytes:current.reserveMemoryBytes,capacityMode:'auto'};
 if(current.maxVramBytes!==undefined)next.maxVramBytes=current.maxVramBytes;
 if(measured.totalMemoryBytes!==null){const reserve=Math.min(512*MiB,Math.max(128*MiB,Math.ceil(measured.totalMemoryBytes/32/MiB)*MiB));next.reserveMemoryBytes=reserve;next.maxMemoryBytes=Math.min(TiB,Math.max(64*MiB,Math.floor((measured.totalMemoryBytes-reserve)/(64*MiB))*64*MiB));}
 if(measured.cpuThreads!==null)next.maxCpuThreads=Math.min(64,Math.max(1,current.ownerMode==='dedicated'?measured.cpuThreads-1:Math.floor(measured.cpuThreads*0.5)));
 if(measured.vramBytes!==null&&measured.vramBytes!==undefined){const usable=Math.floor((measured.vramBytes-256*MiB)/(64*MiB))*64*MiB;next.maxVramBytes=usable>=512*MiB?Math.min(TiB,usable):undefined;}
 return next;
}
export class CoordinatorDeviceSettings {
 private database:CoordinatorDatabase;
 private allotments:CoordinatorAllotments;
 constructor(database:CoordinatorDatabase,allotments:CoordinatorAllotments){this.database=database;this.allotments=allotments;}
 async read(peer:CoordinatorPeer,measured?:CoordinatorMeasuredCapacity):Promise<CoordinatorContribution|null>{
  if(measured){const cpu=measured.cpuThreads,ram=measured.totalMemoryBytes,vram=measured.vramBytes??null;
   if(Object.keys(measured).some(k=>!['cpuThreads','totalMemoryBytes','vramBytes'].includes(k))||cpu!==null&&(!Number.isInteger(cpu)||cpu<1||cpu>1024)||ram!==null&&(!Number.isSafeInteger(ram)||ram<64*MiB||ram>64*TiB)||vram!==null&&(!Number.isSafeInteger(vram)||vram<0||vram>64*TiB))throw Error('MEASUREMENT_INVALID');
  }
  let settings:CoordinatorContribution|null=null;
  await this.database.transaction(async(db:CoordinatorTransaction):Promise<void>=>{const row=await db.querySql('SELECT spaceId,holderId,settingsJson,userId FROM SpaceDevice WHERE id=?',[peer.deviceId]);try{if(row.goToFirstRow()&&row.getString(0)===peer.groupId&&row.getString(3)===peer.principalId&&(row.getString(1)===peer.holderInstanceId||peer.app!==undefined))settings=JSON.parse(row.getString(2)) as CoordinatorContribution;}finally{row.close();}});
  if(settings===null||!measured)return settings;const current=settings as CoordinatorContribution;if(current.capacityMode!=='auto')return current;
  const next=coordinatorAutoContribution(current,measured),capacity:ResourceAmountV2[]=[{resourcePoolId:'cpu',amount:next.maxCpuThreads},{resourcePoolId:'ram',amount:next.maxMemoryBytes}];
  if(next.maxVramBytes)capacity.push({resourcePoolId:'gpu',amount:1},{resourcePoolId:'vram',amount:next.maxVramBytes});
  const budget=await this.allotments.budget(peer.deviceId);
  try{await this.allotments.confirmDevice(peer.deviceId,capacity,budget?.bindings??[{groupId:peer.groupId,holderInstanceId:peer.holderInstanceId,appInstanceId:null}]);}
  catch(e){if(['BUDGET_RECONCILIATION_REQUIRED','BINDING_HAS_UNSETTLED_RESERVATION'].includes((e as Error).message))return current;throw e as Error;}
  await this.database.transaction(async(db:CoordinatorTransaction):Promise<void>=>{await db.executeSql('UPDATE SpaceDevice SET settingsJson=? WHERE id=?',[JSON.stringify(next),peer.deviceId]);
   const rows=await db.querySql("SELECT id,appId,offlineJson FROM RegisteredInstallation WHERE deviceId=? AND groupId=? AND state='ACTIVE'",[peer.deviceId,peer.groupId]);
   try{while(rows.goToNextRow()){
    const offline=JSON.parse(rows.getString(2)) as ResourceAmountV2[],extra=capacity.map((r:ResourceAmountV2):ResourceAmountV2=>({resourcePoolId:r.resourcePoolId,amount:Math.max(0,r.amount-(offline.find(b=>b.resourcePoolId===r.resourcePoolId)?.amount??0))}));
    await db.executeSql('UPDATE RegisteredInstallation SET onlineJson=? WHERE id=?',[JSON.stringify(extra),rows.getString(0)]);
    await db.executeSql('UPDATE RegisteredApp SET resourcesJson=?,maxConcurrent=64 WHERE id=?',[JSON.stringify(capacity),rows.getString(1)]);
   }}finally{rows.close();}});return next;
 }
}
