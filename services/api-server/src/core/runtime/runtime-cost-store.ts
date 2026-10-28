import { AsyncLocalStorage } from 'node:async_hooks';
import { CapabilityCostModel, costConfiguration } from './capability-cost-model';
import { createHash, randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { Injectable, Optional, Logger } from '@nestjs/common';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { RuntimeWorkScope } from './runtime-work-scope';

export const COST_WINDOW_MS = 24 * 60 * 60 * 1000;
export const EVIDENCE_WINDOW_MS = 30 * COST_WINDOW_MS;
export const LINK_WINDOW_MS = 10 * 60 * 1000;
export type CostScope = 'execution' | 'roundtrip' | 'upload' | 'download' | 'relay-return' | 'coordination';
export type SampleSource = 'BUSINESS' | 'CALIBRATION';
export interface CostIdentity {
  capability: string; deviceId: string; scope: CostScope; sizeBucket: number;
  configuration: string; executorVersion: string; networkId: string;
}
export interface CostSample {
  count: number; failures: number; mean: number; deviation: number; observedAt: number;
  successAt?: number; bytes?: number;
}
interface Observation extends CostIdentity {
  id: string; sampleKey: string; durationMs: number; success: boolean;
  source: SampleSource; errorClass: string | null; bytes: number | null; observedAt: Date;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([,v])=>v!==undefined)
    .sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function costKey(capability: string, deviceId: string, bytes: number, parameters: unknown,
  scope: CostScope = 'execution', executorVersion = '1', networkId = 'unknown',model?:CapabilityCostModel): string {
  const link=scope==='upload'||scope==='download'||scope==='relay-return'||scope==='coordination';
  return 'cost:v3:' + canonical({capability:link?'transport.bytes.v1':capability,deviceId,scope,
    sizeBucket:link?0:Math.floor(Math.log2(Math.max(1,bytes))),
    configuration:createHash('sha256').update(canonical(link?{}:costConfiguration(parameters,model))).digest('hex'),
    executorVersion:link?'transport-v1':executorVersion,networkId:scope==='execution'?'none':networkId});
}
export function costIdentity(key: string): CostIdentity { const match=/^cost:v[23]:(.*)$/.exec(key); if(!match)throw new Error('COST_KEY_INVALID'); return JSON.parse(match[1]); }
export function sampleTtl(identity: CostIdentity): number {
  if (identity.scope === 'execution') return COST_WINDOW_MS;
  // An unknown network cannot safely reuse a ten-minute transfer/roundtrip measurement.
  return identity.networkId.startsWith('unknown') ? 30_000 : LINK_WINDOW_MS;
}
export function networkIdentity(target?: string): string {
  const interfaces=Object.entries(networkInterfaces()).flatMap(([name,addresses])=>
    (addresses??[]).filter(a=>!a.internal).map(a=>[name,a.family,a.cidr])).sort((a,b)=>canonical(a).localeCompare(canonical(b)));
  // Interface/subnet changes invalidate the pair. An operator epoch can additionally mark VPN/path changes.
  return target && interfaces.length ? createHash('sha256').update(canonical([interfaces,process.env.RUNTIME_NETWORK_ID??'',target])).digest('hex') : 'unknown';
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

/** The Nest provider is shared; manual service construction shares a store per Prisma client. */
@Injectable()
export class RuntimeCostStore {
  private static readonly qualityScope=new AsyncLocalStorage<{ownerId:string;deviceId:string;remaining:number}>();
  private static readonly stores=new WeakMap<object,RuntimeCostStore>();
  static shared(prisma?:PrismaService):RuntimeCostStore {
    if(!prisma)return new RuntimeCostStore();
    let store=this.stores.get(prisma);
    if(!store){store=new RuntimeCostStore(prisma);this.stores.set(prisma,store);}
    return store;
  }
  private readonly logger = new Logger(RuntimeCostStore.name);
  private readonly buckets = new Map<string, Observation[]>();
  private observations: Observation[] = [];
  private writes: Promise<void> = Promise.resolve();
  private readonly quotas = new Map<string, number>();
  private refreshTimer?:ReturnType<typeof setInterval>;
  private cleanupTimer?:ReturnType<typeof setInterval>;
  private refreshJob?:Promise<void>;
  private cleanupJob?:Promise<void>;
  private lastSync=0;
  private lastFullSync=0;
  constructor(@Optional() private readonly prisma?: PrismaService) {}

  async onModuleInit():Promise<void>{
    await this.load();
    if(!this.prisma||this.refreshTimer)return;
    this.refreshTimer=setInterval(()=>{void this.refresh().catch(()=>this.logger.warn('COST_CACHE_REFRESH_FAILED'));},5000);
    this.cleanupTimer=setInterval(()=>{void this.cleanup().catch(()=>this.logger.warn('COST_CLEANUP_FAILED'));},3600000);
    this.refreshTimer.unref();this.cleanupTimer.unref();
  }
  async onModuleDestroy():Promise<void>{
    clearInterval(this.refreshTimer);clearInterval(this.cleanupTimer);
    await Promise.allSettled([this.flush(),this.refreshJob,this.cleanupJob]);
  }
  async load(): Promise<void> {
    if (!this.prisma) return;
    const began=Date.now();
    const rows=await this.prisma.runtimeCostObservation.findMany({where:{observedAt:{gt:new Date(began-COST_WINDOW_MS),lte:new Date(began)}},
      orderBy:[{observedAt:'desc'},{id:'desc'}],take:8192});
    for(const row of rows.reverse())this.cache(row as Observation);
    this.lastSync=began;
    this.lastFullSync=began;
  }
  async refresh():Promise<void>{
    if(!this.prisma)return;
    if(this.refreshJob)return this.refreshJob;
    this.refreshJob=RuntimeWorkScope.settlement(async()=>{
      // Recover delayed commits whose execution timestamp predates the incremental overlap.
      if(Date.now()-this.lastFullSync>=60000)await this.load();
      const until=new Date(),since=new Date(Math.max(Date.now()-COST_WINDOW_MS,this.lastSync-10000));
      let cursor:string|undefined;
      do {
        const rows=await this.prisma!.runtimeCostObservation.findMany({where:{observedAt:{gte:since,lte:until}},
          orderBy:[{observedAt:'asc'},{id:'asc'}],take:1024,...(cursor?{cursor:{id:cursor},skip:1}:{})});
        for(const row of rows)this.cache(row as Observation);
        cursor=rows.length===1024?rows[rows.length-1].id:undefined;
      }while(cursor);
      this.lastSync=until.getTime();
    }).finally(()=>{this.refreshJob=undefined;});
    return this.refreshJob;
  }
  async cleanup():Promise<void>{
    if(!this.prisma)return;
    if(this.cleanupJob)return this.cleanupJob;
    this.cleanupJob=RuntimeWorkScope.settlement(async()=>{
      const rows=await this.prisma!.runtimeCostObservation.findMany({where:{observedAt:{lt:new Date(Date.now()-EVIDENCE_WINDOW_MS)}},select:{id:true},take:1000});
      if(rows.length)await this.prisma!.runtimeCostObservation.deleteMany({where:{id:{in:rows.map(r=>r.id)}}});
    }).finally(()=>{this.cleanupJob=undefined;});
    return this.cleanupJob;
  }
  private cache(row: Observation): void {
    const old=this.buckets.get(row.sampleKey)??[];
    if(old.some(r=>r.id===row.id))return;
    const rows=[...old,row].sort((a,b)=>a.observedAt.getTime()-b.observedAt.getTime()||a.id.localeCompare(b.id)).slice(-256);
    this.buckets.delete(row.sampleKey);this.buckets.set(row.sampleKey,rows);
    if(this.buckets.size>1024)this.buckets.delete(this.buckets.keys().next().value!);
  }
  record(key: string, ms: number, success: boolean, bytes?: number,
    source: SampleSource = 'BUSINESS', errorClass?: string): void {
    if (!Number.isFinite(ms)||ms<0) return;
    const row: Observation = {...costIdentity(key),id:randomUUID(),sampleKey:key,durationMs:ms,success,
      bytes:bytes??null,source,errorClass:success?null:(errorClass&&/^[A-Z0-9_]{1,100}$/.test(errorClass)?errorClass:'EXECUTION_FAILED'),observedAt:new Date()};
    this.cache(row);
    if (!this.prisma) {
      this.observations=this.observations.filter(r=>r.observedAt.getTime()>Date.now()-EVIDENCE_WINDOW_MS);
      this.observations.push(row);return;
    }
    const write=this.writes.then(()=>RuntimeWorkScope.settlement(async()=>{
      await this.prisma!.runtimeCostObservation.create({data:row});
    }));
    this.writes=write.catch(()=>{this.logger.warn('DISPATCH_FEEDBACK_PERSISTENCE_FAILED');});
    RuntimeWorkScope.track(this.writes);
  }
  async flush(): Promise<void> { await this.writes; }
  private recent(key:string):Observation[]{
    const now=Date.now(),since=now-sampleTtl(costIdentity(key));
    return (this.buckets.get(key)??[]).filter(r=>r.observedAt.getTime()>since&&r.observedAt.getTime()<=now);
  }
  async get(key: string): Promise<CostSample | undefined> {
    // The planning path neither flushes telemetry nor queries SQLite.
    let sample:CostSample|undefined;
    for(const row of this.recent(key))sample=accumulate(sample,row.durationMs,row.success,row.observedAt.getTime(),row.bytes??undefined);
    return sample;
  }
  link(deviceId:string,scope:'upload'|'download'|'relay-return',networkId:string){
    const key=costKey('',deviceId,0,{},scope,'',networkId);
    const rows=this.recent(key).filter(r=>r.success&&r.bytes!==null&&r.bytes>0);
    if(rows.length<3)return;
    const n=rows.length,mx=rows.reduce((s,r)=>s+r.bytes!,0)/n,my=rows.reduce((s,r)=>s+r.durationMs,0)/n;
    const variance=rows.reduce((s,r)=>s+(r.bytes!-mx)**2,0);
    let slope=variance>0?rows.reduce((s,r)=>s+(r.bytes!-mx)*(r.durationMs-my),0)/variance:0;
    if(!Number.isFinite(slope)||slope<=0)slope=Math.max(...rows.map(r=>Math.max(1,r.durationMs)/r.bytes!));
    // Upper envelope of measured residuals, so a noisy fit cannot advertise an optimistic fixed delay.
    const fixedMs=Math.max(0,...rows.map(r=>r.durationMs-slope*r.bytes!));
    return {bytesPerSecond:1000/slope,fixedMs,observedAt:Math.max(...rows.map(r=>r.observedAt.getTime())),ttlMs:sampleTtl(costIdentity(key))};
  }
  async evidence(capability: string, deviceId: string, scope: CostScope, executorVersion='1', networkId='unknown') {
    const now=Date.now(),since=new Date(now-EVIDENCE_WINDOW_MS);
    const where={capability,deviceId,scope,executorVersion,observedAt:{gt:since,lte:new Date(now)}};
    let successes:number,failures:number,lastSuccessAt:number|null,recentFailures:number,recentTotal:number;
    let consecutiveFailures=0,lastAttemptAt:number|null=null;
    if(this.prisma){
      // Admission uses committed records; pending writes may delay activation, never fabricate evidence.
      const [groups,last,recent,tail]=await Promise.all([
        this.prisma.runtimeCostObservation.groupBy({by:['success'],where,_count:{_all:true}}),
        this.prisma.runtimeCostObservation.findFirst({where:{...where,success:true},orderBy:{observedAt:'desc'},select:{observedAt:true}}),
        this.prisma.runtimeCostObservation.groupBy({by:['success'],where:{...where,observedAt:{gt:new Date(now-COST_WINDOW_MS),lte:new Date(now)}},_count:{_all:true}}),
        this.prisma.runtimeCostObservation.findMany({where:{...where,observedAt:{gt:new Date(now-COST_WINDOW_MS),lte:new Date(now)}},orderBy:[{observedAt:'desc'},{id:'desc'}],take:3,select:{success:true,observedAt:true}})
      ]);
      lastAttemptAt=tail[0]?.observedAt.getTime()??null;
      for(const row of tail){if(row.success)break;consecutiveFailures++;}
      successes=groups.find(g=>g.success)?._count._all??0;failures=groups.find(g=>!g.success)?._count._all??0;
      lastSuccessAt=last?.observedAt.getTime()??null;
      recentFailures=recent.find(g=>!g.success)?._count._all??0;recentTotal=recent.reduce((s,g)=>s+g._count._all,0);
    }else{
      const rows=this.observations.filter(r=>r.capability===capability&&r.deviceId===deviceId&&r.scope===scope&&r.executorVersion===executorVersion&&
        r.observedAt>since&&r.observedAt.getTime()<=now);
      successes=rows.filter(r=>r.success).length;failures=rows.length-successes;
      lastSuccessAt=rows.filter(r=>r.success).reduce<number|null>((n,r)=>Math.max(n??0,r.observedAt.getTime()),null);
      const recent=rows.filter(r=>r.observedAt.getTime()>now-COST_WINDOW_MS);
      recentFailures=recent.filter(r=>!r.success).length;recentTotal=recent.length;
      lastAttemptAt=recent.length?Math.max(...recent.map(r=>r.observedAt.getTime())):null;
      for(const row of [...recent].reverse()){if(row.success)break;consecutiveFailures++;}
    }
    const failureRate=Math.max(failures/Math.max(1,successes+failures),recentTotal>=5?recentFailures/recentTotal:0);
    return {sampleCount:successes,failureRate,lastSuccessAt,consecutiveFailures,circuitOpen:consecutiveFailures>=3,probeAllowed:lastAttemptAt===null||now-lastAttemptAt>=60000};
  }
  async withQualityCalibration<T>(ownerId:string,deviceId:string,cases:number,work:()=>Promise<T>):Promise<T>{
    if(!Number.isSafeInteger(cases)||cases<3||cases>5)throw new Error('QUALITY_CALIBRATION_CASE_COUNT_INVALID');
    if(RuntimeCostStore.qualityScope.getStore())throw new Error('QUALITY_CALIBRATION_NESTED');
    await this.consumeQuota(ownerId,deviceId,'quality',2);
    return RuntimeCostStore.qualityScope.run({ownerId,deviceId,remaining:cases},work);
  }
  async consumeCalibration(ownerId:string,deviceId:string):Promise<void>{
    const batch=RuntimeCostStore.qualityScope.getStore();
    if(batch){
      if(batch.ownerId!==ownerId||batch.deviceId!==deviceId||batch.remaining<=0)throw new Error('QUALITY_CALIBRATION_SCOPE_EXHAUSTED');
      batch.remaining--;return;
    }
    return this.consumeQuota(ownerId,deviceId,'speed',5);
  }
  private async consumeQuota(ownerId: string, deviceId: string,kind:'quality'|'speed',limit:number): Promise<void> {
    if (!ownerId) throw new Error('OWNER_ID_REQUIRED');
    // UTC days are stable across hosts; quota is shared by explicit and background calibration.
    const day=new Date().toISOString().slice(0,10), id=canonical([ownerId,deviceId,day,kind]);
    if (this.prisma) {
      // Atomic conditional update; neither restart nor concurrent coordinators can exceed five.
      await this.prisma.runtimeCalibrationQuota.upsert({where:{id},create:{id,ownerId,deviceId,day,attempts:0},update:{}});
      const used=await this.prisma.runtimeCalibrationQuota.updateMany({where:{id,attempts:{lt:limit}},data:{attempts:{increment:1}}});
      if (!used.count) throw new Error('CALIBRATION_QUOTA_EXHAUSTED');
    } else {
      const count=this.quotas.get(id)??0;
      if(count>=limit) throw new Error('CALIBRATION_QUOTA_EXHAUSTED');
      this.quotas.set(id,count+1);
    }
  }
}
