export interface CostSample {
  count: number; failures: number; mean: number; deviation: number; observedAt: number;
  successAt?: number; bytes?: number;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([,v])=>v!==undefined)
    .sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function accumulate(old: CostSample | undefined, ms: number, success: boolean, now: number, bytes?: number): CostSample {
  const next = {...(old ?? {count:0,failures:0,mean:0,deviation:0,observedAt:now})};
  if (success) {
    // A failure never seeds or refreshes the successful latency estimate.
    if (!next.count) { next.mean=ms; next.deviation=0; }
    else { next.deviation=.75*next.deviation+.25*Math.abs(ms-next.mean); next.mean=.75*next.mean+.25*ms; }
    next.count++; next.successAt=now;
    if (bytes !== undefined) next.bytes=next.bytes===undefined?bytes:.75*next.bytes+.25*bytes;
  } else next.failures++;
  next.observedAt=now;
  return next;
}


export interface LinkObservation { bytes: number; durationMs: number; observedAt: number; }
/** Conservative envelope around measured positive-throughput samples; no I/O or clock. */
export function fitLink(rows: readonly LinkObservation[], ttlMs: number) {
  if(rows.length<3 || !Number.isFinite(ttlMs) || ttlMs<=0 || rows.some(r=>
    !Number.isFinite(r.bytes)||r.bytes<=0||!Number.isFinite(r.durationMs)||r.durationMs<0||!Number.isFinite(r.observedAt)))return;
  const n=rows.length,mx=rows.reduce((s,r)=>s+r.bytes,0)/n,my=rows.reduce((s,r)=>s+r.durationMs,0)/n;
  const variance=rows.reduce((s,r)=>s+(r.bytes-mx)**2,0);
  let slope=variance>0?rows.reduce((s,r)=>s+(r.bytes-mx)*(r.durationMs-my),0)/variance:0;
  if(!Number.isFinite(slope)||slope<=0)slope=Math.max(...rows.map(r=>Math.max(1,r.durationMs)/r.bytes));
  const fixedMs=Math.max(0,...rows.map(r=>r.durationMs-slope*r.bytes));
  return {bytesPerSecond:1000/slope,fixedMs,observedAt:Math.max(...rows.map(r=>r.observedAt)),ttlMs};
}
