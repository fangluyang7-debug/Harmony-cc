import { util } from '@kit.ArkTS';
import { CoordinatorDatabase, CoordinatorTransaction } from './CoordinatorDatabase';
import { CoordinatorArtifacts, CoordinatorArtifact } from './CoordinatorArtifacts';
import { CoordinatorJobs } from './CoordinatorJobs';
import { CoordinatorPeer } from './CoordinatorCredentials';
import { SdkSubmission, SdkInput } from '../client/SchedulerSdk';
import { TaskContractV2 } from '../protocol/SchedulingProtocolV2';
import { NativePhotoEngine } from './generated/PlanningCore';
import { hash, bytes } from '../platform/NativeTransport';
interface ReferenceManifest {contract:TaskContractV2;model:Object|null;}
interface Reference {manifest:ReferenceManifest;}
interface Part {nodeId:string;descriptor:CoordinatorArtifact;}
interface BundlePart {nodeId:string;schemaId:string;contentHash:string;bytes:number;data:string;}
interface Bundle {version:number;parts:BundlePart[];}
interface Call {sourceLocal:boolean;ids:string[];key:string;value:Object;prefix:string;peer:CoordinatorPeer;input:SdkInput;id:string;descriptor:CoordinatorArtifact;data:string;hash:string;bytes:number;capability:string;submission:SdkSubmission;source:CoordinatorArtifact;parts:Part[];}
interface NativeOfferView {target:Object;}
interface NativeJobView {offer:NativeOfferView;}
interface EvaluationDiagnostic {state:string;work:Object;result:Object|null;}
interface AttemptDiagnostic {id:string;rejection:Object|null;record:Object|null;yieldNotice:Object|null;}
interface PhotoDiagnostic {evaluations:EvaluationDiagnostic[];jobs:Object[];traces:Object[];attempts:Object[];}
export class CoordinatorPhoto {
 readonly engine:NativePhotoEngine;
 private timer:number=-1;
 private packs:Reference[];
 private database:CoordinatorDatabase;
 private artifacts:CoordinatorArtifacts;
 private jobs:CoordinatorJobs;
 constructor(database:CoordinatorDatabase,artifacts:CoordinatorArtifacts,jobs:CoordinatorJobs,referenceJson:string){
  this.database=database;this.artifacts=artifacts;this.jobs=jobs;
  this.packs=JSON.parse(referenceJson) as Reference[];
  this.engine=new NativePhotoEngine({call:(operation:string,payload:string):Promise<string>=>this.call(operation,payload),id:():string=>util.generateRandomUUID(true),now:():number=>Date.now()});
 }
 async start():Promise<void>{this.jobs.onChanged=():void=>{void this.engine.tick();};await this.engine.restore();this.timer=setInterval(()=>{void this.engine.tick();},200);}
 close():void{this.jobs.onChanged=null;if(this.timer!==-1)clearInterval(this.timer);this.timer=-1;}
 async diagnostics():Promise<string>{
  const evaluations:EvaluationDiagnostic[]=[],jobs:Object[]=[],traces:Object[]=[],attempts:Object[]=[];
  await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{
   const rows=await tx.querySql('SELECT state,workJson,resultJson FROM EvaluationDispatch ORDER BY rowid DESC LIMIT 12');try{while(rows.goToNextRow()){const raw=rows.getString(2);evaluations.push({state:rows.getString(0),work:JSON.parse(rows.getString(1)) as Object,result:raw?JSON.parse(raw) as Object:null});}}finally{rows.close();}
   const jr=await tx.querySql('SELECT metadataJson FROM CpuJob ORDER BY rowid DESC LIMIT 300');try{while(jr.goToNextRow())jobs.push(JSON.parse(jr.getString(0)) as Object);}finally{jr.close();}
   const tr=await tx.querySql('SELECT metadataJson FROM TraceSpan ORDER BY rowid DESC LIMIT 2400');try{while(tr.goToNextRow())traces.push(JSON.parse(tr.getString(0)) as Object);}finally{tr.close();}
   const ar=await tx.querySql('SELECT id,rejectionJson,recordJson,yieldJson FROM Attempt ORDER BY rowid DESC LIMIT 300');try{while(ar.goToNextRow()){const rejection=ar.getString(1),record=ar.getString(2),notice=ar.getString(3);attempts.push({id:ar.getString(0),rejection:rejection?JSON.parse(rejection) as Object:null,record:record?JSON.parse(record) as Object:null,yieldNotice:notice?JSON.parse(notice) as Object:null} as AttemptDiagnostic);}}finally{ar.close();}
  });return JSON.stringify({evaluations,jobs,traces,attempts} as PhotoDiagnostic);
 }
 private async call(op:string,json:string):Promise<string>{
  const v=JSON.parse(json) as Call;
  if(op==='contract'){const p=this.packs.find(p=>p.manifest.contract.capability===v.capability);if(!p)throw Error('CONTRACT_UNKNOWN');return JSON.stringify(p.manifest);}
  if(op==='inspectMany')return this.jobs.inspectMany(v.peer,v.ids);
  if(op==='inspect')return this.jobs.inspect(v.peer,v.id);
  if(op==='cancel')return JSON.stringify(await this.jobs.cancel(v.peer,v.id));
  if(op==='dispatch')return JSON.stringify(await this.jobs.submit(v.peer,v.submission,v.source,true,v.sourceLocal===true));
  const base64=new util.Base64Helper();
  if(op==='validateBytes'){const b=base64.decodeSync(v.data);if(b.length>8388608||v.bytes!==undefined&&b.length!==v.bytes||hash(b)!==v.hash)throw Error('PHOTO_INPUT_INVALID');return 'true';}
  let result='null';await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{
   if(op==='get'){const rows=await tx.querySql('SELECT metadataJson FROM Device WHERE id=?',['native-photo:'+v.key]);try{if(rows.goToFirstRow())result=rows.getString(0);}finally{rows.close();}return;}
   if(op==='put'){await tx.executeSql("INSERT INTO Device (id,groupId,revision,metadataJson) VALUES (?,'native-photo',1,?) ON CONFLICT(id) DO UPDATE SET revision=revision+1,metadataJson=excluded.metadataJson",['native-photo:'+v.key,JSON.stringify(v.value)]);return;}
   if(op==='list'){const rows=await tx.querySql('SELECT metadataJson FROM Device WHERE id LIKE ? ORDER BY rowid DESC',['native-photo:'+v.prefix+'%']),values:Object[]=[];try{while(rows.goToNextRow())values.push(JSON.parse(rows.getString(0)) as Object);}finally{rows.close();}result=JSON.stringify(values);return;}
   if(op==='available'){result=JSON.stringify(await this.artifacts.available(tx,v.descriptor));return;}
   if(op==='ticket'){result=JSON.stringify(await this.artifacts.issue(tx,v.descriptor,v.peer,'READ'));return;}
   if(op==='product'){result=util.TextDecoder.create('utf-8').decodeToString(base64.decodeSync(await this.artifacts.readContent(tx,v.descriptor)));return;}
   let descriptor:CoordinatorArtifact;
   if(op==='bundle'){
    const parts:BundlePart[]=[];for(const p of v.parts)parts.push({nodeId:p.nodeId,schemaId:p.descriptor.ref.schemaId,contentHash:p.descriptor.ref.contentHash,bytes:p.descriptor.bytes,data:await this.artifacts.readContent(tx,p.descriptor)});
    const data=bytes(JSON.stringify({version:1,parts} as Bundle));descriptor={groupId:v.peer.groupId,ownerPrincipalId:v.peer.principalId,ref:{artifactId:v.id,contentVersion:1,contentHash:hash(data),schemaId:'artifact.bundle',schemaVersion:1},bytes:data.length,expiresAt:Date.now()+3600000};
    await this.artifacts.writeContent(tx,descriptor,base64.encodeToStringSync(data));result=JSON.stringify(descriptor);return;
   }
   if(op==='artifact'){descriptor={groupId:v.peer.groupId,ownerPrincipalId:v.peer.principalId,ref:{artifactId:v.id,contentVersion:1,contentHash:v.input.contentHash,schemaId:v.input.schemaId,schemaVersion:v.input.schemaVersion},bytes:v.input.bytes,expiresAt:Date.now()+3600000};result=JSON.stringify({descriptor,ticket:await this.artifacts.issue(tx,descriptor,v.peer,'WRITE')});return;}
   throw Error('PHOTO_PORT_UNKNOWN');
  });return result;
 }
}
