import { http } from '@kit.NetworkKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { CancellationSignal } from '../api/SchedulerTypes';
import { RouteProbePort, RemoteTaskProfile, RouteCandidate } from '../api/RemoteRouteProfile';
interface ProbeFailure {code?:number;message?:string;}
interface CapabilityCheck { available: boolean; reason?: string; }
interface ProbeData { retryAfterMs?: number; checks?: Record<string, CapabilityCheck>; checkedAt?: string; receivedBytes?: number; available?: boolean; queueMs?: number; padding?: string;
  capabilities?: Record<string, CapabilityCheck> }
interface ProbeEnvelope { data: ProbeData; }
export class HttpRouteProbe implements RouteProbePort {
  private readonly baseUrl: string;
  private readonly routeId: string;
  private readonly headers: Object;
  private readonly signal?: CancellationSignal;
  private readonly deadlineAt: number;
  private readonly capability: string;
  constructor(baseUrl: string, routeId: string, headers: Object, signal: CancellationSignal | undefined,
    deadlineAt: number, capability: string) {
    this.baseUrl = baseUrl; this.routeId = routeId; this.headers = headers; this.signal = signal; this.deadlineAt = deadlineAt;
    this.capability = capability;
  }
  public async probe(profile: RemoteTaskProfile): Promise<RouteCandidate> {
    // Provider checks can be slower than transport probes. Measure RTT last so
    // a slow model probe cannot immediately expire the newly selected route.
    const health = await this.readyHealth();
    const pingStart = Date.now();
    const ping = await this.call('/ping');
    if (ping.available !== true) { throw new Error('ROUTE_UNREACHABLE'); }
    const rtt = Math.max(1, Date.now() - pingStart);
    const pingAt = Date.now();
    // Effective throughput includes protocol overhead: a conservative bound, not link capacity.
    const sampleBytes = profile.latencyClass === 'realtime' ? 4096 : profile.latencyClass === 'interactive' ? 8192 : 32768;
    const payload = JSON.stringify({ payload: 'x'.repeat(sampleBytes) });
    const upStart = Date.now();
    const uploaded = await this.call('/upload', payload);
    if (uploaded.receivedBytes !== sampleBytes) { throw new Error('UPLOAD_PROBE_INVALID'); }
    const up = utf8Bytes(payload) * 8 / Math.max(1, Date.now() - upStart) / 1000;
    const downStart = Date.now();
    const download = await this.call('/download');
    if (download.padding?.length !== 32768) { throw new Error('DOWNLOAD_PROBE_INVALID'); }
    const down = utf8Bytes(JSON.stringify(download)) * 8 / Math.max(1, Date.now() - downStart) / 1000;
    const bandwidthAt = Date.now();
    const queue = await this.call('/minimal-task', '{}');
    if (queue.queueMs === undefined || !Number.isFinite(queue.queueMs) || queue.queueMs < 0) { throw new Error('QUEUE_PROBE_INVALID'); }
    return { routeId: this.routeId, backend: 'cloud', networkKey: this.baseUrl,
      rttMs: rtt, uplinkMbps: up, downlinkMbps: down, cloudQueueMs: queue.queueMs,
      cloudReachability: true, remoteDependencyHealth: health.capabilities?.[this.capability]?.available === true,
      observedAt: pingAt, bandwidthAt: bandwidthAt, dependenciesAt: health.checkedAt === undefined ? Date.now() : Date.parse(health.checkedAt),
      source: 'measured-effective-throughput', estimatedUploadMs: 0, estimatedDownloadMs: 0,
      estimatedTotalMs: 0, costEstimate: null };
  }
  private async readyHealth(): Promise<ProbeData> {
    for(let attempt=0;attempt<2;attempt++) {
      const health=await this.call('/api/v1/health/capabilities?capability='+encodeURIComponent(this.capability));
      const capability=health.capabilities?.[this.capability];
      if(capability?.available===true)return health;
      const missing=(capability?.reason??'').replace('DEPENDENCIES_NOT_READY:','').split(',');
      const reasons=missing.map((name:string):string=>health.checks?.[name]?.reason??'DEPENDENCY_UNKNOWN');
      hilog.warn(0x0000,'SoleAITrace','stage=dependency-check capability=%{public}s reasons=%{public}s attempt=%{public}d',this.capability,JSON.stringify(reasons),attempt+1);
      if(reasons.some((reason:string)=>reason.endsWith('HTTP_429')))throw new Error('REMOTE_MODEL_RATE_LIMITED');
      if(reasons.some((reason:string)=>/HTTP_40[13]$|MODEL_CONFIG_MISSING|MODEL_INTEGRATION_DEFERRED/.test(reason)))throw new Error('REMOTE_MODEL_CONFIGURATION');
      if(missing.some((name:string)=>name==='catalog'||name==='catalogText'))throw new Error('REMOTE_CATALOG_UNAVAILABLE');
      const transient=reasons.length>0&&reasons.every((reason:string)=>/MODEL_PROBE_(TIMEOUT|NETWORK|HTTP_5[0-9][0-9])$|PROBE_FAILED$/.test(reason));
      const observed=health.checkedAt===undefined?Date.now():Date.parse(health.checkedAt);
      const waitMs=Math.max(250,Math.min(16000,health.retryAfterMs??Math.max(0,15000-(Date.now()-(Number.isFinite(observed)?observed:Date.now()))))+100);
      if(attempt===1||!transient||this.deadlineAt-Date.now()<waitMs+5000)throw new Error('REMOTE_UNAVAILABLE');
      await this.pause(waitMs);
    }
    throw new Error('REMOTE_UNAVAILABLE');
  }
  private async pause(ms:number):Promise<void>{
    if(this.signal?.isCancellationRequested)throw new Error('CLOUD_CANCELLED');
    await new Promise<void>((resolve,reject)=>{
      let unsubscribe:()=>void=()=>{};
      const timer=setTimeout(()=>{unsubscribe();resolve();},ms);
      unsubscribe=this.signal?.onCancelled(()=>{clearTimeout(timer);unsubscribe();reject(new Error('CLOUD_CANCELLED'));})??(()=>{});
    });
  }
  private async call(path: string, body: string = ''): Promise<ProbeData> {
    for(let attempt=0;attempt<2;attempt++){
      try{return await this.callOnce(path,body);}
      catch(error){
        if(this.signal?.isCancellationRequested)throw new Error('CLOUD_CANCELLED');
        const code=(error as Error).message;
        // These endpoints only measure connectivity; retrying cannot create a shopping task.
        if(attempt!==0||!['ROUTE_PROBE_NETWORK_2300028','ROUTE_PROBE_NETWORK_2300055','ROUTE_PROBE_NETWORK_2300056','ROUTE_PROBE_HTTP_502','ROUTE_PROBE_HTTP_503','ROUTE_PROBE_HTTP_504'].includes(code)||this.deadlineAt-Date.now()<1000)throw error as Error;
        hilog.warn(0x0000,'SoleAITrace','stage=route-retry path=%{public}s attempt=2 reason=%{public}s',path,code);
      }
    }
    throw new Error('ROUTE_PROBE_FAILED');
  }
  private async callOnce(path: string, body: string): Promise<ProbeData> {
    if (this.signal?.isCancellationRequested) { throw new Error('CLOUD_CANCELLED'); }
    const remaining = Math.min(path.startsWith('/api/v1/health/')?35000:20000, this.deadlineAt - Date.now());
    if (remaining <= 0) { throw new Error('ROUTE_PROBE_DEADLINE'); }
    const request = http.createHttp();
    const unsubscribe = this.signal?.onCancelled(() => request.destroy());
    try {
      const url = path.startsWith('/api/') ? this.baseUrl + path : this.baseUrl + '/api/v1/runtime/probe' + path;
      const response = await request.request(url, {
        method: body.length === 0 ? http.RequestMethod.GET : http.RequestMethod.POST,
        header: this.headers, extraData: body, connectTimeout: Math.min(10000, remaining), readTimeout: remaining });
      if (response.responseCode !== 200 && response.responseCode !== 201) { throw new Error('ROUTE_PROBE_HTTP_'+response.responseCode); }
      return (JSON.parse(String(response.result)) as ProbeEnvelope).data;
    } catch (error) {
      const failure=error as ProbeFailure;
      hilog.error(0x0000,'SoleAITrace','stage=route-probe path=%{public}s code=%{public}s',path,String(failure.code??failure.message??'UNKNOWN'));
      if(typeof failure.code==='number')throw new Error('ROUTE_PROBE_NETWORK_'+failure.code);
      throw error as Error;
    } finally { unsubscribe?.(); request.destroy(); }
  }
}
function utf8Bytes(value: string): number {
  let count: number = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) { count++; }
    else if (code < 0x800) { count += 2; }
    else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xDC00 && value.charCodeAt(i + 1) <= 0xDFFF) { count += 4; i++; }
    else { count += 3; }
  }
  return count;
}
