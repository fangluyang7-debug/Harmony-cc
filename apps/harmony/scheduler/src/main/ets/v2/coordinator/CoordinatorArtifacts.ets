import { util } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { CoordinatorDatabase, CoordinatorTransaction } from './CoordinatorDatabase';
import { CoordinatorPeer, CoordinatorCredentials } from './CoordinatorCredentials';
import { CoordinatorHttpRequest } from './CoordinatorHttpParser';
import { CoordinatorHttpResponse } from './CoordinatorTlsServer';
import { SdkRef, SdkTicket } from '../client/SchedulerSdk';
import { validArtifactRefV2, ArtifactRefV2 } from '../protocol/SchedulingProtocolV2';
import { canonical } from '../core/CanonicalV2';
import { hash, bytes } from '../platform/NativeTransport';
export interface CoordinatorArtifact {groupId:string;ownerPrincipalId:string;ref:SdkRef;bytes:number;expiresAt:number;}
interface ArtifactRow {descriptor:CoordinatorArtifact;content:string|null;}
interface TicketRow {ticket:SdkTicket;groupId:string;holderInstanceId:string;credentialId:string;}
const artifactKey=(group:string,ref:SdkRef):string=>JSON.stringify(['native-artifact',group,ref.artifactId,ref.contentVersion]);
const ticketKey=(token:string):string=>JSON.stringify(['native-artifact-ticket',hash(bytes(token))]);
async function read(tx:CoordinatorTransaction,id:string):Promise<string|null>{const rows=await tx.querySql('SELECT metadataJson FROM Device WHERE id=?',[id]);try{return rows.goToFirstRow()?rows.getString(0):null;}finally{rows.close();}}
async function put(tx:CoordinatorTransaction,id:string,group:string,value:Object):Promise<void>{await tx.executeSql('INSERT INTO Device (id,groupId,revision,metadataJson) VALUES (?,?,1,?) ON CONFLICT(id) DO UPDATE SET revision=revision+1,metadataJson=excluded.metadataJson',[id,group,JSON.stringify(value)]);}
/** Relay tickets bind both the authenticated holder and immutable artifact digest. */
export class CoordinatorArtifacts {
 private database:CoordinatorDatabase;
 private credentials:CoordinatorCredentials;
 constructor(database:CoordinatorDatabase,credentials:CoordinatorCredentials){this.database=database;this.credentials=credentials;}
 async register(tx:CoordinatorTransaction,descriptor:CoordinatorArtifact):Promise<void>{
  if(!validArtifactRefV2(descriptor.ref as ArtifactRefV2)||!Number.isSafeInteger(descriptor.bytes)||descriptor.bytes<1||descriptor.bytes>8388608||descriptor.expiresAt<=Date.now())throw Error('ARTIFACT_INVALID');
  const id=artifactKey(descriptor.groupId,descriptor.ref),old=await read(tx,id);
  if(old!==null){if(canonical((JSON.parse(old) as ArtifactRow).descriptor)!==canonical(descriptor))throw Error('ARTIFACT_CONFLICT');return;}
  const row:ArtifactRow={descriptor,content:null};await put(tx,id,descriptor.groupId,row);
 }
 async issue(tx:CoordinatorTransaction,descriptor:CoordinatorArtifact,peer:CoordinatorPeer,operation:string):Promise<SdkTicket>{
  if(peer.groupId!==descriptor.groupId||!['READ','WRITE'].includes(operation))throw Error('ARTIFACT_SCOPE');
  await this.register(tx,descriptor);
  const token=new util.Base64Helper().encodeToStringSync(cryptoFramework.createRandom().generateRandomSync(32).data).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const ticket:SdkTicket={token,ref:descriptor.ref,bytes:descriptor.bytes,expiresAt:Math.min(descriptor.expiresAt,Date.now()+60000),operation};
  const row:TicketRow={ticket,groupId:peer.groupId,holderInstanceId:peer.holderInstanceId,credentialId:peer.credentialId};await put(tx,ticketKey(token),peer.groupId,row);return ticket;
 }
 async available(tx:CoordinatorTransaction,descriptor:CoordinatorArtifact):Promise<boolean>{const raw=await read(tx,artifactKey(descriptor.groupId,descriptor.ref));return raw!==null&&(JSON.parse(raw) as ArtifactRow).content!==null&&descriptor.expiresAt>Date.now();}
 async handle(request:CoordinatorHttpRequest):Promise<CoordinatorHttpResponse>{
  const peer=await this.credentials.authenticate(request.deviceCredential??'');
  if(!request.authorization.startsWith('Bearer '))throw Error('ARTIFACT_TICKET_REQUIRED');
  const token=request.authorization.slice(7);if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw Error('ARTIFACT_TICKET_INVALID');
  let response:CoordinatorHttpResponse={status:200,body:''};
  await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{
   const raw=await read(tx,ticketKey(token));if(raw===null)throw Error('ARTIFACT_TICKET_INVALID');
   const row=JSON.parse(raw) as TicketRow,ticket=row.ticket;
   if(row.groupId!==peer.groupId||row.holderInstanceId!==peer.holderInstanceId||row.credentialId!==peer.credentialId||ticket.expiresAt<=Date.now()||request.path!=='/v2/artifacts/'+ticket.ref.artifactId+'/'+ticket.ref.contentVersion||request.method!==(ticket.operation==='WRITE'?'PUT':'GET'))throw Error('ARTIFACT_SCOPE');
   const id=artifactKey(peer.groupId,ticket.ref),data=await read(tx,id);if(data===null)throw Error('ARTIFACT_MISSING');
   const artifact=JSON.parse(data) as ArtifactRow;
   if(artifact.descriptor.expiresAt<=Date.now()||artifact.descriptor.bytes!==ticket.bytes||canonical(artifact.descriptor.ref)!==canonical(ticket.ref))throw Error('ARTIFACT_EXPIRED');
   const base64=new util.Base64Helper();
   if(ticket.operation==='WRITE'){
    if(request.body.length!==ticket.bytes||hash(request.body)!==ticket.ref.contentHash)throw Error('ARTIFACT_INTEGRITY');
    const content=base64.encodeToStringSync(request.body);if(artifact.content!==null&&artifact.content!==content)throw Error('ARTIFACT_CONFLICT');
    artifact.content=content;await put(tx,id,peer.groupId,artifact);
   }else{
    if(artifact.content===null)throw Error('ARTIFACT_NOT_UPLOADED');
    const body=base64.decodeSync(artifact.content);if(body.length!==ticket.bytes||hash(body)!==ticket.ref.contentHash)throw Error('ARTIFACT_INTEGRITY');
    response={status:200,body:'',binaryBody:body,contentType:'application/octet-stream'};
   }
  });return response;
 }
}
