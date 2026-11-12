import { CoordinatorDatabase, CoordinatorTransaction } from './CoordinatorDatabase';
import { DeviceProfileV2, validDeviceProfileV2 } from '../protocol/ResourcesV2';
interface Registration {installationId:string;}
interface Binding {deviceId:string;}
/** Same group-scoped, membership-aware directory read as the Windows coordinator. */
export class CoordinatorDirectory {
 private database:CoordinatorDatabase;
 constructor(database:CoordinatorDatabase){this.database=database;}
 async profiles(groupId:string):Promise<DeviceProfileV2[]>{
  const result:DeviceProfileV2[]=[];
  await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{
   const rows=await tx.querySql('SELECT id,metadataJson FROM DeviceInstance WHERE groupId=?',[groupId]);
   const candidates:DeviceProfileV2[]=[];
   try{while(rows.goToNextRow()){
    if(!rows.getString(0).startsWith('["profile",'))continue;
    const profile=JSON.parse(rows.getString(1)) as DeviceProfileV2;
    if(validDeviceProfileV2(profile)&&profile.domain==='REAL')candidates.push(profile);
   }}finally{rows.close();}
   for(const profile of candidates){
    const registration=await tx.querySql('SELECT metadataJson FROM Device WHERE id=?',[JSON.stringify(['space-device-installation',profile.deviceId])]);
    let installationId='';
    try{if(registration.goToFirstRow())installationId=(JSON.parse(registration.getString(0)) as Registration).installationId;}finally{registration.close();}
    if(installationId){
     const binding=await tx.querySql('SELECT metadataJson FROM Device WHERE id=?',[JSON.stringify(['space-installation',installationId])]);
     let active=false;
     try{active=binding.goToFirstRow()&&(JSON.parse(binding.getString(0)) as Binding).deviceId===profile.deviceId;}finally{binding.close();}
     if(!active)continue;
    }
    result.push(profile);
   }
  });return result;
 }
}
