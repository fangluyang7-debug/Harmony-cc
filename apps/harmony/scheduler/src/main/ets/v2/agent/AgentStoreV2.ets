import { LedgerStateV2, LedgerIdentityV2, recoverLedgerV2, newLedgerV2, occupiedV2 } from '../core/LedgerV2';
import {ResourceAmountV2} from '../protocol/ResourcesV2';
import { AgentJournalV2, newAgentJournalV2, validateAgentJournalV2 } from './AgentJournalV2';
import { validAttemptRecordV2 } from '../protocol/SchedulingProtocolV2';
import { validDispatchOfferV2 } from '../protocol/ResourcesV2';
export interface AgentSnapshotV2 { format:number;state:LedgerStateV2;journal:AgentJournalV2; }
/** The platform stores state + outbox atomically and enforces one writer per installation. */
export interface AgentPersistenceV2 { load():Promise<string|null>;commit(snapshot:string):Promise<void>; }
export interface AgentChangeV2 { apply(snapshot:AgentSnapshotV2):void; }
export interface AgentJournalChangeV2 { apply(journal:AgentJournalV2):void; }
export class AgentStoreV2 {
 private tail:Promise<void>=Promise.resolve();
 private poisoned=false;
 private snapshot:AgentSnapshotV2;
 private stateJson:string;
 private port:AgentPersistenceV2;
 private constructor(snapshot:AgentSnapshotV2,port:AgentPersistenceV2){this.snapshot=snapshot;this.port=port;this.stateJson=JSON.stringify(snapshot.state);}
 static async open(identity:LedgerIdentityV2,port:AgentPersistenceV2):Promise<AgentStoreV2>{
  const raw=await port.load();let saved:AgentSnapshotV2={format:1,state:newLedgerV2(identity),journal:newAgentJournalV2()};
  if(raw!==null){
   saved=JSON.parse(raw) as AgentSnapshotV2;const s=saved.state;
   if(saved.format!==1||!s||s.version!==1||s.groupId!==identity.groupId||s.deviceId!==identity.deviceId||s.holderInstanceId!==identity.holderInstanceId||s.appInstanceId!==identity.appInstanceId||!Number.isSafeInteger(s.ledgerEpoch)||s.ledgerEpoch<1||!Array.isArray(s.entries)||s.entries.some(e=>!validAttemptRecordV2(e.record)||!validDispatchOfferV2(e.offer)))throw Error('LEDGER_CORRUPT');
   validateAgentJournalV2(saved.journal,s.groupId,s.holderInstanceId);saved.state=recoverLedgerV2(s);
  }
  await port.commit(JSON.stringify(saved));return new AgentStoreV2(saved,port);
 }
 read():AgentSnapshotV2 {if(this.poisoned)throw Error('LEDGER_UNAVAILABLE');return JSON.parse(JSON.stringify(this.snapshot)) as AgentSnapshotV2;}
 readJournal():AgentJournalV2 {if(this.poisoned)throw Error('LEDGER_UNAVAILABLE');return JSON.parse(JSON.stringify(this.snapshot.journal)) as AgentJournalV2;}
 occupied():ResourceAmountV2[]{if(this.poisoned)throw Error('LEDGER_UNAVAILABLE');return occupiedV2(this.snapshot.state);}
 /** Channel acknowledgements cannot mutate business state. Still persist the
  * complete atomic snapshot, reusing the immutable state's serialization. */
 changeJournal(change:AgentJournalChangeV2):Promise<void>{
  const run=this.tail.then(async()=>{const journal=this.readJournal();change.apply(journal);validateAgentJournalV2(journal,this.snapshot.state.groupId,this.snapshot.state.holderInstanceId);
   try{await this.port.commit('{"format":1,"state":'+this.stateJson+',"journal":'+JSON.stringify(journal)+'}');}catch(e){this.poisoned=true;throw Error('LEDGER_COMMIT_FAILED');}
   this.snapshot={format:1,state:this.snapshot.state,journal};
  });this.tail=run.catch(()=>{});return run;
 }
 /** Hot cancellation polling returns a scalar, never clones historical receipts
  * or exposes mutable ledger references to an executor. */
 isCancelled(attemptId:string,now:number):boolean {if(this.poisoned)throw Error('LEDGER_UNAVAILABLE');const e=this.snapshot.state.entries.find(e=>e.record.attemptId===attemptId);return !e||e.cancelRequested||now>=e.deadline;}
 change(change:AgentChangeV2):Promise<void>{
  const run=this.tail.then(async()=>{
   const next=this.read();change.apply(next);validateAgentJournalV2(next.journal,next.state.groupId,next.state.holderInstanceId);
   const stateJson=JSON.stringify(next.state);
   try{await this.port.commit('{"format":1,"state":'+stateJson+',"journal":'+JSON.stringify(next.journal)+'}');}catch(e){this.poisoned=true;throw Error('LEDGER_COMMIT_FAILED');}
   this.snapshot=next;this.stateJson=stateJson;
  });this.tail=run.catch(()=>{});return run;
 }
 async drained():Promise<void>{await this.tail;}
}
