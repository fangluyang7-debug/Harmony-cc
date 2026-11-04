import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {Prisma} from '../generated/client';

const clock=randomUUID();
export function stamp(){return {clock,mono:performance.now(),at:Date.now()};}
type Stamp=ReturnType<typeof stamp>;
interface RaceTiming {signal?:Stamp;assessment?:Stamp;offer:Stamp;winner?:Stamp;settled:Record<string,Stamp>;}
export const raceKey=(node:string)=>JSON.stringify(['race-timing',node]);
export async function openRaceTiming(tx:Prisma.TransactionClient,group:string,node:string,estimate:string|null){
 const trigger=estimate?JSON.parse(estimate):{};
 const data:RaceTiming={signal:trigger.signal,assessment:trigger.assessment,offer:stamp(),settled:{}};
 await tx.costObservation.create({data:{id:raceKey(node),groupId:group,revision:1,metadataJson:JSON.stringify(data)}});
}
/** Store first observations only. Replayed settlement must not extend a measured delay. */
export async function noteRace(tx:Prisma.TransactionClient,node:string,attempt:string,won:boolean,settled:boolean){
 const id=raceKey(node),row=await tx.costObservation.findUnique({where:{id}});
 if(!row)return; // A pre-upgrade race has no monotonic start reference.
 const data:RaceTiming=JSON.parse(row.metadataJson),now=stamp();
 if(won&&!data.winner)data.winner=now;
 if(settled&&!Object.prototype.hasOwnProperty.call(data.settled,attempt))Object.defineProperty(data.settled,attempt,{value:now,enumerable:true});
 await tx.costObservation.update({where:{id},data:{metadataJson:JSON.stringify(data)}});
}
export function raceIntervals(data:RaceTiming,primary:string,backup:string){
 const elapsed=(a?:Stamp,b?:Stamp)=>a&&b&&a.clock===b.clock&&b.mono>=a.mono?b.mono-a.mono:null;
 const primaryEnd=data.settled[primary],backupEnd=data.settled[backup];
 const last=primaryEnd&&backupEnd&&primaryEnd.clock===backupEnd.clock?(primaryEnd.mono>=backupEnd.mono?primaryEnd:backupEnd):undefined;
 return {signalToAssessmentMs:elapsed(data.signal,data.assessment),assessmentToOfferMs:elapsed(data.assessment,data.offer),
  offerToWinnerMs:elapsed(data.offer,data.winner),winnerToBothSettledMs:elapsed(data.winner,last)};
}
