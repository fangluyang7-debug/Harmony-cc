import { TraceSpanV2, validTraceSpanV2 } from './protocol-v2';

export function analyzeTrace(spans:readonly TraceSpanV2[]){
  const issues=new Set<string>(),byId=new Map<string,TraceSpanV2>();
  for(const s of spans){if(!validTraceSpanV2(s)){issues.add('SPAN_INVALID');continue;}if(byId.has(s.spanId))issues.add('DUPLICATE_SPAN');byId.set(s.spanId,s);}
  if(spans.length>4096||!spans.length||new Set(spans.map(s=>s.traceId)).size!==1)issues.add('TRACE_INVALID');
  const roots=[...byId.values()].filter(s=>s.parentSpanId===null),root=roots.length===1?roots[0]:null;if(!root)issues.add('ROOT_INCOMPLETE');
  const children=new Map<string,string[]>();for(const s of byId.values())if(s.parentSpanId){
    const parent=byId.get(s.parentSpanId);if(!parent)issues.add('PARENT_MISSING');
    else if(parent.clockDomainId===s.clockDomainId&&(s.startMono<parent.startMono-.001||s.endMono>parent.endMono+.001))issues.add('PARENT_INTERVAL_CONFLICT');
    children.set(s.parentSpanId,[...(children.get(s.parentSpanId)??[]),s.spanId]);
  }
  const excluded=new Set<string>();
  const transfers=new Map<string,TraceSpanV2[]>();for(const s of byId.values())if(s.transferId)transfers.set(s.transferId,[...(transfers.get(s.transferId)??[]),s]);
  for(const group of transfers.values()){
    const authority=group.filter(s=>s.measurementScope==='FULL_TRANSFER'&&
      (s.phase==='TRANSFER_SEND'&&s.authoritativeSide==='SENDER'||s.phase==='TRANSFER_RECV'&&s.authoritativeSide==='RECEIVER'));
    if(authority.length!==1||new Set(group.map(s=>s.authoritativeSide)).size!==1){issues.add('TRANSFER_MEASUREMENT_INCOMPLETE');for(const s of group)excluded.add(s.spanId);continue;}
    // Deduplicate work, not completion milestones: compute can start at the
    // receiver before the sender receives the HTTP response.
    for(const s of group)if(s!==authority[0])excluded.add(s.spanId);
  }
  const leaves=[...byId.values()].filter(s=>s!==root&&!children.has(s.spanId));
  const totals={computeMs:0,waitMs:0,transferMs:0,otherMs:0};for(const s of leaves){
    if(excluded.has(s.spanId))continue;
    if(s.phase==='EXECUTE')totals.computeMs+=s.durationMs;
    else if(s.phase==='QUEUE'||s.phase==='YIELD')totals.waitMs+=s.durationMs;
    else if(s.phase.startsWith('TRANSFER_'))totals.transferMs+=s.durationMs;
    else totals.otherMs+=s.durationMs;
  }
  const visiting=new Set<string>(),done=new Map<string,{finish:number;measured:number;chain:string[]}>();
  const finish=(id:string):{finish:number;measured:number;chain:string[]}=>{
    if(done.has(id))return done.get(id)!;
    if(visiting.has(id)){issues.add('CAUSAL_CYCLE');return {finish:0,measured:0,chain:[]};}visiting.add(id);
    const s=byId.get(id);if(!s){issues.add('DEPENDENCY_MISSING');visiting.delete(id);return {finish:0,measured:0,chain:[]};}
    let predecessor={finish:0,measured:0,chain:[] as string[]};
    for(const dep of s.dependsOn){
      const earlier=byId.get(dep);
      if(earlier?.transferId&&earlier.transferId===s.transferId)continue; // Observations of one transfer overlap, rather than run serially.
      if(earlier&&earlier.clockDomainId===s.clockDomainId&&earlier.endMono>s.startMono+.001)issues.add('CAUSAL_OVERLAP');
      const f=finish(dep);if(f.finish>predecessor.finish)predecessor=f;
    }
    let value;
    if(children.has(id)){
      value=predecessor;for(const child of children.get(id)!){const f=finish(child);if(f.finish>value.finish)value=f;}
      if(s.dependsOn.length)issues.add('CONTAINER_DEPENDENCY_UNRESOLVED');
    }else{
      let offset=predecessor.finish;
      if(root&&root.clockDomainId===s.clockDomainId){
        if(s.startMono<root.startMono||s.endMono>root.endMono)issues.add('ROOT_INTERVAL_CONFLICT');
        offset=Math.max(offset,s.startMono-root.startMono);
      }else issues.add('CROSS_CLOCK_GAP_UNKNOWN');
      let duration=s.durationMs;
      if(s.transferId&&predecessor.chain.some(dep=>byId.get(dep)?.transferId===s.transferId)){issues.add('TRANSFER_CAUSAL_CONFLICT');duration=0;}
      value={finish:offset+duration,measured:predecessor.measured+duration,chain:[...predecessor.chain,id]};
    }
    visiting.delete(id);done.set(id,value);return value;
  };
  let critical={finish:0,measured:0,chain:[] as string[]};for(const s of leaves){const f=finish(s.spanId);if(f.finish>critical.finish)critical=f;}
  for(const s of byId.values())if(s!==root)finish(s.spanId);
  if(critical.chain.some(id=>excluded.has(id)))issues.add('CRITICAL_TRANSFER_BOUNDARY_PARTIAL');
  const residual=root?root.durationMs-critical.measured:null;
  if(residual!==null&&residual<-.001)issues.add('NEGATIVE_RESIDUAL');
  return {status:issues.size?'MEASUREMENT_INCOMPLETE':'COMPLETE',issues:[...issues].sort(),endToEndMs:root?.durationMs??null,
    work:totals,criticalPathMs:critical.finish,criticalSpanIds:critical.chain,measuredCriticalMs:critical.measured,
    predictionErrors:[...byId.values()].filter(s=>s!==root&&!excluded.has(s.spanId)&&s.predictedMs!==null).map(s=>({spanId:s.spanId,phase:s.phase,targetId:s.targetId,snapshotVersion:s.snapshotVersion,predictedMs:s.predictedMs!,measuredMs:s.durationMs,errorMs:s.durationMs-s.predictedMs!})),
    unexplainedMs:issues.size?null:residual,negativeResidualMs:residual!==null&&residual<0?residual:null};
}
