import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {projectTraceCausality,validTraceCausality,TraceJobEvidence,TraceTransferEvidence} from '../src/trace-causality';
import {analyzeTrace} from '../src/trace-analysis';
const base=JSON.parse(readFileSync(resolve(__dirname,'../../../contracts/scheduling/v2/fixtures/valid/TraceSpan.json'),'utf8'));
const span=(id:string,attempt:string,phase:string,start:number,end:number,deps:string[]=[])=>({...base,spanId:id,attemptId:attempt,nodeId:attempt,phase,startMono:start,endMono:end,durationMs:end-start,dependsOn:deps,parentSpanId:null});
const job=(attemptId:string,parents:string[]=[]):TraceJobEvidence=>({attemptId,parents,dispatched:true,missingParent:false,unsplitTransfer:false});
function execution(id:string,offset:number){return ['PLAN','QUEUE','ADMIT','LOAD','EXECUTE','PUBLISH'].map((phase,i)=>span(id+'-'+phase,id,phase,offset+i*2,offset+i*2+1,i>1?[id+'-'+['PLAN','QUEUE','ADMIT','LOAD','EXECUTE','PUBLISH'][i-1]]:[]));}
test('durable node dependencies become explicit causal links under the source root without changing recorded spans',()=>{
 const recorded=[span('root','b','DELIVER',0,50),...execution('b',1),...execution('c',20)];
 const result=projectTraceCausality(recorded,'root',[job('b'),job('c',['b'])],[]),analysis=analyzeTrace(result.spans);
 expect(recorded.every(s=>s.parentSpanId===null)).toBe(true);expect(result.spans.filter(s=>s.spanId!=='root').every(s=>s.parentSpanId==='root')).toBe(true);
 expect(result.causality.complete).toBe(true);expect(validTraceCausality(result.causality,result.spans)).toBe(true);
 expect(result.spans.find(s=>s.spanId==='c-PLAN')!.dependsOn).toContain('b-PUBLISH');expect(analysis.status).toBe('COMPLETE');expect(analysis.work.otherMs).toBe(8);expect(analysis.endToEndMs).toBe(50);
 expect(validTraceCausality({...result.causality,links:[{beforeSpanId:'foreign',afterSpanId:'c-PLAN',reason:'WRONG'}]},result.spans)).toBe(false);
});
test('missing plan, missing source clock and unsplit legacy I/O remain incomplete',()=>{
 const result=projectTraceCausality(execution('b',1).filter(s=>s.phase!=='PLAN'),null,[{...job('b'),unsplitTransfer:true}],[]);
 expect(result.causality.complete).toBe(false);expect(result.causality.missing).toEqual(expect.arrayContaining(['PLAN_BEFORE_DISPATCH_SPAN_MISSING','SOURCE_SDK_ROOT_NOT_RECORDED','LEGACY_DATA_TRANSFER_NOT_SPLIT']));
});
test('verified receiver milestones unlock compute and a forwarded copy links only within the real source process clock',()=>{
 const transfers:TraceTransferEvidence[]=[{id:'t1',attemptId:'c',producerAttemptId:'b',producerHolderId:'B',senderHolderId:'B',receiverHolderId:'C',refKey:'app-full-ref'},
   {id:'t2',attemptId:'c',producerAttemptId:'b',producerHolderId:'B',senderHolderId:'C',receiverHolderId:'D',refKey:'app-full-ref'}];
 const transfer=(id:string,phase:string,clock:string,start:number,end:number)=>({...span(id,'c',phase,start,end),transferId:id.startsWith('first')?'t1':'t2',clockDomainId:clock,authoritativeSide:'SENDER',measurementScope:phase==='TRANSFER_SEND'?'FULL_TRANSFER':'PARTIAL_TRANSFER'});
 const recorded=[span('root','b','DELIVER',0,100),...execution('b',1),...execution('c',40),transfer('first-send','TRANSFER_SEND','B-clock',10,35),transfer('first-recv','TRANSFER_RECV','C-clock',12,20),transfer('forward-send','TRANSFER_SEND','C-clock',22,34),transfer('forward-recv','TRANSFER_RECV','D-clock',25,30)];
 const result=projectTraceCausality(recorded,'root',[job('b'),job('c',['b'])],transfers);
 expect(result.spans.find(s=>s.spanId==='forward-send')!.dependsOn).toContain('first-recv');
 expect(result.spans.find(s=>s.spanId==='c-QUEUE')!.dependsOn).toEqual(expect.arrayContaining(['first-recv','forward-recv']));
 expect(result.spans.find(s=>s.spanId==='c-QUEUE')!.dependsOn).not.toContain('first-send');
 const restarted=projectTraceCausality(recorded.map(s=>s.spanId==='forward-send'?{...s,clockDomainId:'C-restarted'}:s),'root',[job('b'),job('c')],transfers);
 expect(restarted.causality.missing).toContain('FORWARDED_COPY_LINK_NOT_RECORDED');
 expect(analyzeTrace(result.spans).issues).toContain('CROSS_CLOCK_GAP_UNKNOWN');
});

test('local HTTP partition preserves raw spans and accounts for unclassified phase time once',()=>{
 const root=span('root','b','DELIVER',0,40),before=span('compute','b','EXECUTE',0,10);
 const parent={...span('publish','b','PUBLISH',10,30,['compute']),predictedMs:25};
 const http={...span('http','b','TRANSFER_SEND',14,24),parentSpanId:'publish',transferId:'http',measurementScope:'FULL_TRANSFER',authoritativeSide:'SENDER'};
 const input=[root,before,parent,http],original=JSON.stringify(input);
 const result=projectTraceCausality(input,'root',[],[]),analysis=analyzeTrace(result.spans);
 expect(JSON.stringify(input)).toBe(original);
 expect(result.spans.filter(s=>s.reasonCode==='LOCAL_PHASE_UNCLASSIFIED').map(s=>s.durationMs)).toEqual([4,6]);
 expect(analysis.work).toEqual({computeMs:10,waitMs:0,transferMs:10,otherMs:10});
 expect(analysis.measuredCriticalMs).toBe(30);expect(analysis.unexplainedMs).toBe(10);
 expect(analysis.predictionErrors.find(s=>s.spanId==='publish')!.errorMs).toBe(-5);
 const invalid=projectTraceCausality([root,before,parent,{...http,clockDomainId:'another-process'}],'root',[],[]);
 expect(invalid.causality.missing).toContain('LOCAL_PHASE_PARTITION_UNPROVEN');
 expect(invalid.spans.some(s=>s.reasonCode==='LOCAL_PHASE_UNCLASSIFIED')).toBe(false);
});

test('phase partition refuses overlapping requests and dependency overflow without changing input',()=>{
 const root=span('root','b','DELIVER',0,40),parent=span('publish','b','PUBLISH',0,30,['prior']);
 const a={...span('a','b','TRANSFER_SEND',2,20),parentSpanId:'publish',transferId:'a',measurementScope:'FULL_TRANSFER',authoritativeSide:'SENDER'};
 const b={...a,spanId:'b',transferId:'b',startMono:10,endMono:25,durationMs:15};
 const overlap=projectTraceCausality([root,parent,a,b],'root',[],[]);
 expect(overlap.causality.missing).toContain('LOCAL_PHASE_PARTITION_UNPROVEN');
 expect(overlap.spans.some(s=>s.reasonCode==='LOCAL_PHASE_UNCLASSIFIED')).toBe(false);
 const full={...a,startMono:0,endMono:30,durationMs:30,dependsOn:Array.from({length:64},(_,i)=>'dep'+i)};
 const input=[root,parent,full],saved=JSON.stringify(input),limited=projectTraceCausality(input,'root',[],[]);
 expect(limited.causality.missing).toContain('CAUSAL_DEPENDENCY_LIMIT');expect(JSON.stringify(input)).toBe(saved);
 expect(limited.spans.find(s=>s.spanId==='a')!.dependsOn).toHaveLength(64);
});
