import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzeTrace } from '../src/trace-analysis';
const base=JSON.parse(readFileSync(resolve(__dirname,'../../../contracts/scheduling/v2/fixtures/valid/TraceSpan.json'),'utf8'));
const span=(id:string,start:number,end:number,deps:string[]=[])=>({...base,spanId:id,startMono:start,endMono:end,durationMs:end-start,dependsOn:deps,parentSpanId:id==='root'?null:'root'});
test('serial trace reports measured residual; overlap, negative duration budget, missing dependency and clock restart are explicit',()=>{
 const input=[span('root',0,30),span('a',0,10),span('b',10,20,['a'])];expect(analyzeTrace(input).unexplainedMs).toBe(10);
 expect(analyzeTrace([input[0],input[1],span('b',5,15,['a'])]).issues).toContain('CAUSAL_OVERLAP');
 const negative=analyzeTrace([span('root',0,10),span('a',0,15),span('b',15,25,['a'])]);expect(negative.negativeResidualMs).toBe(-15);expect(negative.unexplainedMs).toBeNull();
 expect(analyzeTrace([input[0],span('b',10,20,['missing'])]).issues).toContain('DEPENDENCY_MISSING');
 expect(analyzeTrace([input[0],{...input[1],clockDomainId:'restarted'}]).issues).toContain('CROSS_CLOCK_GAP_UNKNOWN');
});
test('parallel critical path follows arrival and resource-wait dependencies while work is summed separately',()=>{
 const r=analyzeTrace([span('root',0,30),span('a',0,10),span('b',0,15),{...span('wait',15,20,['b']),phase:'QUEUE'},span('join',20,25,['a','wait'])]);
 expect(r.status).toBe('COMPLETE');expect(r.criticalPathMs).toBe(25);expect(r.measuredCriticalMs).toBe(25);expect(r.work.computeMs).toBe(30);expect(r.work.waitMs).toBe(5);expect(r.unexplainedMs).toBe(5);
 const delayed=analyzeTrace([span('root',0,30),span('a',0,10),span('b',12,20)]);expect(delayed.criticalPathMs).toBe(20);expect(delayed.measuredCriticalMs).toBe(8);
});
test('a transfer counts its declared full authoritative interval once, never the maximum of arbitrary endpoints',()=>{
 const tx={...span('tx',0,10),phase:'TRANSFER_SEND',transferId:'transfer1',measurementScope:'PARTIAL_TRANSFER',authoritativeSide:'RECEIVER'};
 const rx={...span('rx',0,20,['tx']),phase:'TRANSFER_RECV',transferId:'transfer1',measurementScope:'FULL_TRANSFER',authoritativeSide:'RECEIVER'};
 const r=analyzeTrace([span('root',0,25),tx,rx]);expect(r.work.transferMs).toBe(20);expect(r.status).toBe('COMPLETE');
 expect(analyzeTrace([span('root',0,25),tx]).issues).toContain('TRANSFER_MEASUREMENT_INCOMPLETE');
 expect(analyzeTrace([span('root',0,25),{...tx,authoritativeSide:'SENDER'},rx]).issues).toContain('TRANSFER_MEASUREMENT_INCOMPLETE');
});

test('receiver readiness is not replaced by the later sender response; partial milestones do not inflate work',()=>{
 const tx={...span('tx',0,20),phase:'TRANSFER_SEND',transferId:'transfer1',measurementScope:'FULL_TRANSFER',authoritativeSide:'SENDER'};
 const rx={...span('rx',0,10),phase:'TRANSFER_RECV',transferId:'transfer1',measurementScope:'PARTIAL_TRANSFER',authoritativeSide:'SENDER'};
 const r=analyzeTrace([span('root',0,35),tx,rx,span('compute',10,30,['rx'])]);
 expect(r.work.transferMs).toBe(20);expect(r.work.computeMs).toBe(20);expect(r.criticalPathMs).toBe(30);
 expect(r.criticalSpanIds).toEqual(['rx','compute']);expect(r.issues).not.toContain('CAUSAL_OVERLAP');expect(r.issues).toContain('CRITICAL_TRANSFER_BOUNDARY_PARTIAL');expect(r.unexplainedMs).toBeNull();
 const conflict=analyzeTrace([span('root',0,35),tx,{...rx,measurementScope:'FULL_TRANSFER',authoritativeSide:'RECEIVER'}]);
 expect(conflict.work.transferMs).toBe(0);expect(conflict.issues).toContain('TRANSFER_MEASUREMENT_INCOMPLETE');
 const io=analyzeTrace([span('root',0,20),{...span('io',0,10),phase:'LOAD'}]);expect(io.work.computeMs).toBe(0);expect(io.work.otherMs).toBe(10);
 const predicted=analyzeTrace([span('root',0,20),{...span('compute',0,10),predictedMs:50}]);expect(predicted.predictionErrors[0].errorMs).toBe(-40);expect(predicted.predictionErrors[0].snapshotVersion).toBe(1);
});

test('nested transfer excludes its container from work but preserves the phase prediction comparison',()=>{
 const publication={...span('publish',0,20),phase:'PUBLISH',predictedMs:25};
 const http={...span('http',2,18),parentSpanId:'publish',phase:'TRANSFER_SEND',transferId:'http',measurementScope:'FULL_TRANSFER',authoritativeSide:'SENDER'};
 const result=analyzeTrace([span('root',0,30),publication,http]);
 expect(result.work.transferMs).toBe(16);expect(result.work.otherMs).toBe(0);
 expect(result.predictionErrors).toEqual([{spanId:'publish',phase:'PUBLISH',targetId:publication.targetId,snapshotVersion:publication.snapshotVersion,predictedMs:25,measuredMs:20,errorMs:-5}]);
});
