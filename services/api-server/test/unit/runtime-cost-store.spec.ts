import { IMAGE_CROP_CONTRACT } from '../../src/core/capabilities/image-crop-contract';
import { admissionEvidence } from '../../src/core/runtime/placement-admission-evidence';
import { PrismaClient } from '@prisma/client';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import sharp = require('sharp');
import { RuntimeCostStore, accumulate, costKey, costIdentity, sampleTtl, COST_WINDOW_MS, EVIDENCE_WINDOW_MS } from '../../src/core/runtime/runtime-cost-store';
import { CropQualityEvaluator, cropFixtureHash, CropQualityFixture } from '../../src/core/runtime/crop-quality-evaluator';
import { PrismaService } from '../../src/persistence/prisma/prisma.service';
import { authorizePlacement } from '../../src/core/runtime/workflow-placement-planner';
import { DeviceDispatchService } from '../../src/core/runtime/device-dispatch.service';
import { PhoneDispatchService } from '../../src/modules/runtime/phone-dispatch.service';
import { MacroSchedulerService } from '../../src/core/runtime/macro-scheduler.service';
import { RuntimeWorkScope } from '../../src/core/runtime/runtime-work-scope';
import { CapabilityQualityRegistry } from '../../src/core/runtime/capability-quality-registry';

describe('cost pipeline persistence and evidence',()=>{
  let folder:string,db:PrismaClient;
  const parameters={targetSize:64,jpegQuality:82,box:{x:0,y:0,width:1,height:1}};
  const cropKey=(bytes:number,p:unknown)=>costKey('image.crop.v1','worker',bytes,p,'execution','1','unknown',IMAGE_CROP_CONTRACT.costModel);
  const key=cropKey(1000,parameters);
  const store=()=>new RuntimeCostStore(db as unknown as PrismaService);
  beforeAll(async()=>{
    folder=await mkdtemp(path.join(tmpdir(),'harmony-costs-'));
    db=new PrismaClient({datasources:{db:{url:'file:'+path.join(folder,'test.db').replace(/\\/g,'/')}}});
    const sql=await readFile(path.resolve(__dirname,'../../prisma/migrations/000012_runtime_cost_observations/migration.sql'),'utf8');
    // Migration is safe for both new databases and repeated db:init.
    for(let i=0;i<2;i++)for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.$executeRawUnsafe(statement);
    const approval=await readFile(path.resolve(__dirname,'../../prisma/migrations/000013_capability_approval/migration.sql'),'utf8');
    for(let i=0;i<2;i++)for(const statement of approval.split(';').map(s=>s.trim()).filter(Boolean))await db.$executeRawUnsafe(statement);
  });
  beforeEach(async()=>{await db.runtimeCostObservation.deleteMany();await db.runtimeCalibrationQuota.deleteMany();await db.runtimeQualityEvidence.deleteMany();});
  afterEach(()=>jest.restoreAllMocks());
  it('isolates manual quality decisions by capability, device and version, including revocation and expiry',async()=>{
    const registry=new CapabilityQualityRegistry(db as unknown as PrismaService);
    expect(await registry.approved('text.count','terminal','v1')).toBe(false);
    await registry.setManualApproval('text.count','terminal','v1',true,'reviewer','fixed corpus checked',new Date(Date.now()+60000));
    expect(await registry.approved('text.count','terminal','v1')).toBe(true);
    expect(await registry.approved('text.other','terminal','v1')).toBe(false);
    expect(await registry.approved('text.count','other','v1')).toBe(false);
    expect(await registry.approved('text.count','terminal','v2')).toBe(false);
    await registry.setManualApproval('text.count','terminal','v1',false,'reviewer','regression found',new Date(Date.now()+60000));
    expect(await registry.approved('text.count','terminal','v1')).toBe(false);
    await registry.setManualApproval('text.count','terminal','v1',true,'reviewer','retested',new Date(Date.now()+60000));
    jest.spyOn(Date,'now').mockReturnValue(Date.now()+61000);
    expect(await registry.approved('text.count','terminal','v1')).toBe(false);
  });
  it('uses registered quality evaluators instead of manual or global approval',async()=>{
    const registry=new CapabilityQualityRegistry(db as unknown as PrismaService);
    const evaluator={approved:jest.fn().mockResolvedValue(false)};
    registry.register('text.validated',evaluator);
    expect(await registry.approved('text.validated','terminal','v1')).toBe(false);
    expect(evaluator.approved).toHaveBeenCalledWith('terminal','v1');
    await expect(registry.setManualApproval('text.validated','terminal','v1',true,'reviewer','bypass',new Date(Date.now()+60000))).rejects.toThrow('MANUAL_QUALITY_APPROVAL_UNAVAILABLE');
    const dispatch=new DeviceDispatchService(undefined,undefined,undefined,undefined,undefined,registry);
    const evidence=await (dispatch as any).rolloutEvidence({qualityPassed:true},'unreviewed','terminal');
    expect(evidence.qualityPassed).toBe(false);
  });
  it('does not amplify one sparse recent failure and permits bounded recovery probes after cooldown',async()=>{
    const costs=store();
    for(let i=0;i<30;i++)costs.record(key,10,true);
    await costs.flush();
    await db.runtimeCostObservation.updateMany({data:{observedAt:new Date(Date.now()-2*COST_WINDOW_MS)}});
    costs.record(key,100,false);await costs.flush();
    expect(await costs.evidence('image.crop.v1','worker','execution')).toMatchObject({failureRate:1/31,circuitOpen:false});
    costs.record(key,100,false);costs.record(key,100,false);await costs.flush();
    const evidence=await costs.evidence('image.crop.v1','worker','execution');
    expect(evidence).toMatchObject({circuitOpen:true,probeAllowed:false});
    const config={mode:'ACTIVE',killSwitch:false,maximumFailureRate:.05} as any;
    expect(admissionEvidence(config,evidence,'x',true).killSwitch).toBe(true);
    jest.spyOn(Date,'now').mockReturnValue(Date.now()+61000);
    const cooled=await costs.evidence('image.crop.v1','worker','execution');
    expect(admissionEvidence(config,cooled,'x',true)).toMatchObject({killSwitch:false,failureRate:0});
    expect(admissionEvidence({...config,killSwitch:true},cooled,'x',true).killSwitch).toBe(true);
    expect(admissionEvidence(config,cooled,'x',false).killSwitch).toBe(true);
    expect(cooled.failureRate).toBe(3/33);
  });
  afterAll(async()=>{
    await db.$disconnect();
    if(path.dirname(path.resolve(folder))===path.resolve(tmpdir())&&path.basename(folder).startsWith('harmony-costs-'))await rm(folder,{recursive:true,force:true});
  });
  it('shares crop classes without mixing measurement scope, versions, capabilities or networks',()=>{
    expect(cropKey(1001,{...parameters,box:{x:.2,y:.3,width:.5,height:.5},jpegQuality:89})).toBe(key);
    expect(cropKey(1000,{...parameters,targetSize:128})).not.toBe(key);
    expect(costKey('image.crop.v1','worker',1000,parameters,'roundtrip')).not.toBe(key);
    expect(costKey('image.crop.v1','worker',1000,parameters,'execution','2')).not.toBe(key);
    expect(costKey('other','worker',1000,parameters)).not.toBe(key);
    expect(costKey('image.crop.v1','worker',1000,parameters,'upload','1','wifi')).not.toBe(costKey('image.crop.v1','worker',1000,parameters,'upload','1','cellular'));
  });
  it('does not seed latency with failures and uses identical smoothing for all scopes',()=>{
    const failed=accumulate(undefined,25000,false,1);
    const success=accumulate(failed,20,true,2);
    expect(success).toMatchObject({count:1,failures:1,mean:20,deviation:0,successAt:2});
    expect(accumulate(success,40,true,3)).toMatchObject({mean:25,deviation:5});
    expect(accumulate(success,25000,false,4)).toMatchObject({mean:20,deviation:0,successAt:2});
  });
  it('restores older execution samples and applies network-specific link lifetimes on every read',async()=>{
    const costs=store(),upload=costKey('image.crop.v1','worker',1000,{},'upload','1','wifi');
    const unknown=costKey('image.crop.v1','worker',1000,{},'upload');
    costs.record(key,20,true);costs.record(upload,10,true,1000);costs.record(unknown,10,true,1000);await costs.flush();
    await db.runtimeCostObservation.updateMany({data:{observedAt:new Date(Date.now()-6*60000)}});
    const restarted=store();await restarted.load();
    expect((await restarted.get(key))!.mean).toBe(20);
    expect((await restarted.get(upload))!.mean).toBe(10);
    expect(await restarted.get(unknown)).toBeUndefined();
    expect(await restarted.get(costKey('image.crop.v1','worker',1000,{},'upload','1','cellular'))).toBeUndefined();
    expect(sampleTtl(costIdentity(key))).toBe(COST_WINDOW_MS);
    const now=Date.now();jest.spyOn(Date,'now').mockReturnValue(now+6*60000);
    expect(await restarted.get(upload)).toBeUndefined();
  });
  it('counts successes and failures in the same rolling window, including calibration but excluding other scopes and expired rows',async()=>{
    const costs=store();
    costs.record(key,10,true,undefined,'CALIBRATION');costs.record(key,20,true);
    costs.record(key,25000,false,undefined,'BUSINESS','TIMEOUT');
    costs.record(costKey('image.crop.v1','worker',1000,{},'upload'),10,true);
    costs.record(costKey('image.crop.v1','other',1000,{}),10,true);
    costs.record(costKey('other','worker',1000,{}),10,true);
    await costs.flush();
    expect(await store().evidence('image.crop.v1','worker','execution')).toMatchObject({sampleCount:2,failureRate:1/3});
    await db.runtimeCostObservation.updateMany({where:{source:'CALIBRATION'},data:{observedAt:new Date(Date.now()-EVIDENCE_WINDOW_MS-1)}});
    expect(await store().evidence('image.crop.v1','worker','execution')).toMatchObject({sampleCount:1,failureRate:.5});
  });
  it('does not lose concurrent observations from different coordinators',async()=>{
    const a=store(),b=store();
    for(let i=0;i<10;i++){a.record(key,10,true);b.record(key,20,true);}
    await Promise.all([a.flush(),b.flush()]);
    expect((await store().evidence('image.crop.v1','worker','execution')).sampleCount).toBe(20);
  });
  it('can reach ACTIVE with five calibrations per day while requiring a recent success',async()=>{
    const costs=store();
    for(let day=0;day<6;day++){
      const k=costKey('image.crop.v1','worker',2**day,{});
      for(let i=0;i<5;i++)costs.record(k,10,true,undefined,'CALIBRATION');
      await costs.flush();
      await db.runtimeCostObservation.updateMany({where:{sampleKey:k},data:{observedAt:new Date(Date.now()-day*COST_WINDOW_MS)}});
    }
    const evidence=await costs.evidence('image.crop.v1','worker','execution');
    expect(evidence.sampleCount).toBe(30);
    const config={mode:'ACTIVE',policyVersion:'test',expiresAt:Date.now()+60000,killSwitch:false,
      allowedDevices:['worker'],allowedCapabilities:['image.crop.v1'],sampleCount:0,minimumSamples:30,
      qualityPassed:true,nonInferiorityPassed:true,failureRate:0,maximumFailureRate:.05,cohortAllowed:true} as const;
    const plan={baseline:[],suggestion:[{deviceId:'worker'}]} as any;
    expect(authorizePlacement(plan,admissionEvidence(config as any,evidence,'request'),'image.crop.v1',Date.now())).toBe(plan.suggestion);
    expect(authorizePlacement(plan,admissionEvidence(config as any,{...evidence,lastSuccessAt:Date.now()-COST_WINDOW_MS-1},'request'),'image.crop.v1',Date.now())).toBe(plan.baseline);
    expect((await costs.evidence('image.crop.v1','worker','execution','2')).sampleCount).toBe(0);
  });
  it('offers bounded opt-in CANARY cohorts without bypassing quality or widening ACTIVE',()=>{
    const config={mode:'CANARY',policyVersion:'test',expiresAt:Date.now()+60000,killSwitch:false,
      allowedDevices:['worker'],allowedCapabilities:['image.crop.v1'],minimumSamples:30,qualityPassed:true,
      nonInferiorityPassed:false,maximumFailureRate:.05,cohortAllowed:true,canaryRate:.1,canaryMinimumSamples:3,canaryMaximumFailureRate:.25} as any;
    const evidence={sampleCount:4,failureRate:.2,lastSuccessAt:Date.now()};
    const plan={baseline:[],suggestion:[{deviceId:'worker'}]} as any;
    let selected=0;
    for(let i=0;i<1000;i++){
      const admitted=admissionEvidence(config,evidence,String(i),false,true);
      if(authorizePlacement(plan,admitted,'image.crop.v1',Date.now())===plan.suggestion){
        selected++;
        expect(authorizePlacement(plan,{...admitted,qualityPassed:false},'image.crop.v1',Date.now())).toBe(plan.baseline);
      }
    }
    expect(selected).toBeGreaterThan(60);expect(selected).toBeLessThan(140);
    expect(authorizePlacement(plan,admissionEvidence({...config,mode:'ACTIVE'},evidence,'x',false,true),'image.crop.v1',Date.now())).toBe(plan.baseline);
    expect(admissionEvidence(config,evidence,'x',false,false).killSwitch).toBe(true);
  });
  it('fits one directional link across capabilities and byte sizes, invalidating it on network change',()=>{
    const costs=new RuntimeCostStore();
    for(const bytes of [100,1000,10000])costs.record(costKey('app-'+bytes,'peer',bytes,{request:bytes},'upload','different-version','wifi'),5+bytes/100,true,bytes);
    const model=costs.link('peer','upload','wifi')!;
    expect(model.fixedMs).toBeCloseTo(5);expect(model.bytesPerSecond).toBeCloseTo(100000);
    expect(costs.link('peer','download','wifi')).toBeUndefined();
    expect(costs.link('peer','upload','cellular')).toBeUndefined();
  });
  it('uses size-only defaults for a second app and honors its declared cost parameters',()=>{
    expect(costKey('text.process','device',100,{text:'first'})).toBe(costKey('text.process','device',110,{text:'second'}));
    const model={version:'text-v1',parameters:[{name:'tokens',bucketWidth:100}]};
    expect(costKey('text.process','device',100,{tokens:20,text:'a'},'execution','1','unknown',model))
      .toBe(costKey('text.process','device',100,{tokens:90,text:'b'},'execution','1','unknown',model));
    expect(costKey('text.process','device',100,{tokens:200},'execution','1','unknown',model))
      .not.toBe(costKey('text.process','device',100,{tokens:20},'execution','1','unknown',model));
  });
  it('automatically learns a non-shopping capability without per-request text fragmenting its history',async()=>{
    const costs=new RuntimeCostStore(),dispatch=new DeviceDispatchService(undefined,new MacroSchedulerService(),undefined,undefined,costs);
    for(const text of ['first request','second request'])await RuntimeWorkScope.run(new AbortController().signal,
      {storageReadMs:0,storageWriteMs:0,modelMs:0},()=>dispatch.dispatch({capability:'text.count.v1',inputs:[],tasks:[{
        id:'count',capability:'text.count.v1',inputs:[],dependencies:[],parameters:{text},memoryMB:1,outputBytes:0,minQuality:1}]},
      {budgetMs:5000,networkAllowed:false,privacyLevel:'LOCAL_ONLY',userWaiting:true,importance:1},
      {remoteAllowed:false,cloudExecutors:{'text.count.v1':async()=>text.length}}),'local-user',5000);
    expect((await costs.get(costKey('text.count.v1','cloud-runtime',0,{})))!.count).toBe(2);
  });
  it('reads immediately while persistence is blocked and never runs cleanup from a record',async()=>{
    let release!:()=>void;
    const client={runtimeCostObservation:{create:jest.fn(()=>new Promise<void>(resolve=>{release=resolve;})),findMany:jest.fn(),deleteMany:jest.fn()}};
    const costs=new RuntimeCostStore(client as unknown as PrismaService);
    costs.record(key,15,true);
    expect((await costs.get(key))!.mean).toBe(15);
    expect(client.runtimeCostObservation.findMany).not.toHaveBeenCalled();
    expect(client.runtimeCostObservation.deleteMany).not.toHaveBeenCalled();
    release();await costs.flush();
  });
  it('refreshes another process observations without duplicating cached samples',async()=>{
    const a=store(),b=store();await b.load();
    a.record(key,15,true);await a.flush();
    expect(await b.get(key)).toBeUndefined();
    await b.refresh();await b.refresh();
    expect((await b.get(key))!.count).toBe(1);
  });
  it('shares an explicitly injected memory store between phone and dispatcher without a database',async()=>{
    const costs=new RuntimeCostStore();
    const phone=new PhoneDispatchService(undefined as any,undefined,costs);
    const dispatch=new DeviceDispatchService(undefined,undefined,undefined,undefined,costs);
    (phone as any).costStore.record(key,15,true);
    expect((await (dispatch as any).costStore.get(key)).mean).toBe(15);
  });
  it('charges a quality suite once, bounds its cases, and leaves the speed quota intact',async()=>{
    const costs=store();
    for(let batch=0;batch<2;batch++)await costs.withQualityCalibration('owner','worker',5,async()=>{
      for(let i=0;i<5;i++)await costs.consumeCalibration('owner','worker');
      await expect(costs.consumeCalibration('owner','worker')).rejects.toThrow('QUALITY_CALIBRATION_SCOPE_EXHAUSTED');
    });
    await expect(costs.withQualityCalibration('owner','worker',3,async()=>{})).rejects.toThrow('CALIBRATION_QUOTA_EXHAUSTED');
    for(let i=0;i<5;i++)await costs.consumeCalibration('owner','worker');
    await expect(costs.consumeCalibration('owner','worker')).rejects.toThrow('CALIBRATION_QUOTA_EXHAUSTED');
    expect((await db.runtimeCalibrationQuota.findMany()).map(q=>q.attempts).sort()).toEqual([2,5]);
  });
  it('shares an atomic daily quota across restarts and resets at the next UTC day',async()=>{
    const results=await Promise.allSettled(Array.from({length:8},()=>store().consumeCalibration('owner','worker')));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(5);
    expect(results.filter(r=>r.status==='rejected').map(r=>(r as PromiseRejectedResult).reason.message)).toEqual(Array(3).fill('CALIBRATION_QUOTA_EXHAUSTED'));
    await expect(store().consumeCalibration('owner','worker')).rejects.toThrow('CALIBRATION_QUOTA_EXHAUSTED');
    await db.runtimeCalibrationQuota.updateMany({data:{id:'previous-day',day:'2000-01-01'}});
    await expect(store().consumeCalibration('owner','worker')).resolves.toBeUndefined();
  });
  it('generates versioned quality evidence only for the fixed fixture set, and a later failed evaluation revokes approval',async()=>{
    const previous=process.env.CROP_QUALITY_POLICY_JSON;
    const image=await sharp({create:{width:64,height:64,channels:3,background:'red'}}).jpeg().toBuffer();
    const wrong=await sharp({create:{width:64,height:64,channels:3,background:'blue'}}).jpeg().toBuffer();
    const fixtures:CropQualityFixture[]=Array.from({length:3},(_,i)=>({id:'case-'+i,input:image,parameters:{...parameters,box:{x:i*.1,y:0,width:.5,height:.5}}}));
    process.env.CROP_QUALITY_POLICY_JSON=JSON.stringify({evaluationId:'unit-test-only',fixtureSetHash:cropFixtureHash(fixtures),minimumPsnrDb:30,minimumCases:3,validForMs:86400000});
    try {
      const evaluator=new CropQualityEvaluator(db as unknown as PrismaService);
      expect((await evaluator.evaluate('worker','1',fixtures,async()=>image,async()=>image)).passed).toBe(true);
      expect(await evaluator.approved('worker','1')).toBe(true);
      expect(await evaluator.approved('worker','2')).toBe(false);
      await expect(evaluator.evaluate('worker','1',fixtures.slice(1),async()=>image,async()=>image)).rejects.toThrow('CROP_QUALITY_FIXTURE_MISMATCH');
      expect((await evaluator.evaluate('worker','1',fixtures,async()=>image,async()=>wrong)).passed).toBe(false);
      expect(await evaluator.approved('worker','1')).toBe(false);
    }finally{if(previous===undefined)delete process.env.CROP_QUALITY_POLICY_JSON;else process.env.CROP_QUALITY_POLICY_JSON=previous;}
  });
});
