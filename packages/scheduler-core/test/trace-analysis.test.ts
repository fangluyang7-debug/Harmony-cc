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
