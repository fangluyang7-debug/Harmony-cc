import { PrismaClient } from '@prisma/client';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DeviceDirectoryService, validateResourceProfile } from '../../src/core/runtime/device-directory.service';
import { PrismaService } from '../../src/persistence/prisma/prisma.service';
import { DeviceDispatchService } from '../../src/core/runtime/device-dispatch.service';
import { MacroSchedulerService } from '../../src/core/runtime/macro-scheduler.service';
import { PhoneDispatchService } from '../../src/modules/runtime/phone-dispatch.service';
import { RuntimeWorkScope } from '../../src/core/runtime/runtime-work-scope';
import { createHash } from 'node:crypto';
import sharp = require('sharp');

describe('persistent device directory',()=>{
  let folder:string,db:PrismaClient,directory:DeviceDirectoryService;
  const token='test-device-token-with-at-least-32-characters';
  const config={deviceId:'worker-test',endpoint:'http://127.0.0.1:3020',tokenEnv:'DIRECTORY_TEST_TOKEN',enabled:true,qualityVerified:true,cropPriorMs:100};
  const profile={version:1,source:'REAL',capabilities:['image.crop.v1'],availableBackends:['CPU'],availableSlots:1,
    availableMemoryMB:256,cpuUsage:12,cpuCores:8,thermalLevel:'NORMAL',queueLength:0};
  let prior:string|undefined;
  beforeAll(async()=>{
    prior=process.env.DIRECTORY_TEST_TOKEN;process.env.DIRECTORY_TEST_TOKEN=token;
    folder=await mkdtemp(path.join(tmpdir(),'harmony-directory-'));
    db=new PrismaClient({datasources:{db:{url:'file:'+path.join(folder,'test.db').replace(/\\/g,'/')}}});
    for(const name of ['000005_phone_dispatch','000006_phone_dispatch_fence','000007_device_directory']) {
      const sql=await readFile(path.resolve(__dirname,'../../prisma/migrations',name,'migration.sql'),'utf8');
      for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.$executeRawUnsafe(statement);
    }
    await db.$executeRawUnsafe('ALTER TABLE PhoneDispatchJob ADD COLUMN kind TEXT NOT NULL DEFAULT \'vector.norm.demo\'');
    await db.$executeRawUnsafe('ALTER TABLE PhoneDispatchJob ADD COLUMN resultJson TEXT');
    directory=new DeviceDirectoryService(db as unknown as PrismaService);
  });
  beforeEach(async()=>{await db.runtimeDevice.deleteMany();await db.phoneDispatchJob.deleteMany();await db.phoneDispatchDevice.deleteMany();await db.runtimeCostSample.deleteMany();});
  afterAll(async()=>{
    await db.$disconnect();
    if(prior===undefined)delete process.env.DIRECTORY_TEST_TOKEN;else process.env.DIRECTORY_TEST_TOKEN=prior;
    if(path.dirname(path.resolve(folder))===path.resolve(tmpdir())&&path.basename(folder).startsWith('harmony-directory-'))await rm(folder,{recursive:true,force:true});
  });
  it('requires a device credential, excludes stale observations, and persists revocation over legacy config',async()=>{
    await directory.registerWorker(config);
    expect(await directory.workers([config])).toEqual([]);
    await expect(directory.heartbeatWorker(config.deviceId,'Bearer wrong',profile)).rejects.toThrow('DEVICE_AUTH_REQUIRED');
    await directory.heartbeatWorker(config.deviceId,'Bearer '+token,profile);
    expect(await directory.workers([])).toEqual([config]);
    await db.runtimeDevice.update({where:{id:config.deviceId},data:{observedAt:new Date(Date.now()-16000)}});
    expect(await directory.workers([config])).toEqual([]);
    await directory.heartbeatWorker(config.deviceId,'Bearer '+token,profile);
    await directory.revoke(config.deviceId);
    const restarted=new DeviceDirectoryService(db as unknown as PrismaService);
    expect(await restarted.workers([config])).toEqual([]);
    await expect(restarted.heartbeatWorker(config.deviceId,'Bearer '+token,profile)).rejects.toThrow('DEVICE_NOT_ACTIVE');
    expect(JSON.stringify(await restarted.list())).not.toContain('tokenEnv');
  });
  it('keeps paired phone identity separate from the requester and filters revoked pairings',async()=>{
    await db.phoneDispatchDevice.create({data:{id:'phone_test',ownerUserId:'owner',workerUserId:'worker'}});
    await expect(directory.reportPhone('intruder','phone_test',profile)).rejects.toThrow('DEVICE_NOT_OWNED');
    await directory.reportPhone('worker','phone_test',profile);
    expect(await directory.phones('intruder')).toEqual([]);
    expect((await directory.phones('owner'))[0].profile.availableMemoryMB).toBe(256);
    await db.runtimeDevice.update({where:{id:'phone_test'},data:{observedAt:new Date(Date.now()-3100)}});
    expect(await directory.phones('owner')).toEqual([]); // Heartbeat lease is still live; resource fields have expired.
    await directory.reportPhone('worker','phone_test',profile);
    await db.phoneDispatchDevice.update({where:{id:'phone_test'},data:{status:'revoked'}});
    expect(await directory.phones('owner')).toEqual([]);
  });
  it('does not convert unknown resources or mock observations into available hardware',()=>{
    expect(validateResourceProfile({...profile,cpuUsage:null,availableMemoryMB:null,cpuCores:null}).cpuUsage).toBeNull();
    expect(()=>validateResourceProfile({...profile,source:'MOCK'})).toThrow('DEVICE_PROFILE_INVALID');
    expect(()=>validateResourceProfile({...profile,availableBackends:['FAKE_GPU']})).toThrow('DEVICE_PROFILE_INVALID');
    expect(()=>validateResourceProfile({...profile,cpuUsage:NaN})).toThrow('DEVICE_PROFILE_INVALID');
  });
  it('restores measured costs after coordinator restart',async()=>{
    await db.runtimeCostSample.create({data:{id:'sample',observedAt:new Date(),sampleJson:JSON.stringify({count:3,mean:50,deviation:2,failures:0,observedAt:Date.now()})}});
    const service=new DeviceDispatchService(undefined,new MacroSchedulerService(),directory,db as unknown as PrismaService);
    await service.onModuleInit();
    expect((service as any).samples.get('sample').mean).toBe(50);
  });
  it('makes phone profiles available to the same macro candidate interface',async()=>{
    await db.phoneDispatchDevice.create({data:{id:'phone_test',ownerUserId:'owner',workerUserId:'worker'}});
    await directory.reportPhone('worker','phone_test',profile);
    const previous=process.env.PHONE_DISPATCH_EXPERIMENT_ENABLED;process.env.PHONE_DISPATCH_EXPERIMENT_ENABLED='true';
    try {
      const phone=new PhoneDispatchService(db as unknown as PrismaService,directory);
      const candidates=await phone.cropAdapters('owner','https://example.test/image',Buffer.from('image'),{box:{x:0,y:0,width:1,height:1},paddingRatio:0,targetSize:64,jpegQuality:80});
      expect(candidates[0].candidate).toMatchObject({deviceId:'phone_test',deviceType:'PHONE',costScope:'coordinator-roundtrip'});
      expect(await phone.cropAdapters('other','https://example.test/image',Buffer.from('image'),{box:{x:0,y:0,width:1,height:1},paddingRatio:0,targetSize:64,jpegQuality:80})).toEqual([]);
    }finally{if(previous===undefined)delete process.env.PHONE_DISPATCH_EXPERIMENT_ENABLED;else process.env.PHONE_DISPATCH_EXPERIMENT_ENABLED=previous;}
  });
  it('plans a paired phone, passes macro context through the lease, fences results and learns actual roundtrip',async()=>{
    const names=['PHONE_DISPATCH_EXPERIMENT_ENABLED','PLACEMENT_POLICY_JSON','RUNTIME_DEVICES_JSON'];
    const previous=names.map(n=>process.env[n]);
    process.env.PHONE_DISPATCH_EXPERIMENT_ENABLED='true';process.env.RUNTIME_DEVICES_JSON='[]';
    process.env.PLACEMENT_POLICY_JSON=JSON.stringify({mode:'ACTIVE',policyVersion:'phone-test',expiresAt:Date.now()+60000,killSwitch:false,
      allowedDevices:['cloud-runtime','phone_test'],allowedCapabilities:['image.crop.v1'],sampleCount:30,minimumSamples:30,
      qualityPassed:true,nonInferiorityPassed:true,failureRate:0,maximumFailureRate:0.05,cohortAllowed:true});
    try {
      await db.phoneDispatchDevice.create({data:{id:'phone_test',ownerUserId:'owner',workerUserId:'worker'}});
      await directory.reportPhone('worker','phone_test',profile);
      const phone=new PhoneDispatchService(db as unknown as PrismaService,directory);
      const bytes=await sharp({create:{width:64,height:64,channels:3,background:'red'}}).jpeg().toBuffer();
      const parameters={box:{x:0,y:0,width:1,height:1},paddingRatio:0,targetSize:64,jpegQuality:80};
      const key=(phone as any).phoneSampleKey('phone_test',bytes.length,parameters);
      await db.runtimeCostSample.create({data:{id:key,sampleJson:JSON.stringify({mean:10,deviation:2,count:3}),observedAt:new Date()}});
      const adapters=await phone.cropAdapters('owner','https://example.test/image',bytes,parameters);
      const dispatch=new DeviceDispatchService(undefined,new MacroSchedulerService(),directory);
      const cloud=jest.fn(async()=>{throw new Error('EXPECTED_PHONE');});
      const input={artifactId:'input',contentVersion:1,schemaVersion:1,schemaId:'shopping.image',contentHash:createHash('sha256').update(bytes).digest('hex'),data:bytes};
      const work=RuntimeWorkScope.run(new AbortController().signal,{storageReadMs:0,storageWriteMs:0,modelMs:0},()=>dispatch.dispatch(
        {capability:'image.crop.v1',inputs:[input],tasks:[{id:'crop',capability:'image.crop.v1',dependencies:[],inputs:['input'],memoryMB:128,outputBytes:bytes.length,minQuality:1,parameters}]},
        {budgetMs:5000,networkAllowed:true,privacyLevel:'AUTHORIZED_REMOTE',userWaiting:true,importance:1},
        {cloudExecutors:{'image.crop.v1':cloud},remoteExecutors:adapters}),'owner',5000);
      let lease:Awaited<ReturnType<PhoneDispatchService['lease']>>|undefined;
      for(let i=0;i<100;i++){lease=await phone.lease('worker','phone_test');if(lease.job)break;await new Promise(r=>setTimeout(r,5));}
      const job=lease!.job!;
      if(!job || !('crop' in job))throw new Error('EXPECTED_CROP_LEASE');
      expect(job.crop?.macroContext).toMatchObject({urgency:true,taskId:'crop'});
      expect(job.crop!.macroContext!.budgetMs).toBeLessThan(5000);
      await expect(phone.cropResult('worker','phone_test',job.jobId,job.fence+1,bytes.toString('base64'),input.contentHash,1)).rejects.toThrow('STALE_OR_REVOKED_LEASE');
      await phone.cropResult('worker','phone_test',job.jobId,job.fence,bytes.toString('base64'),input.contentHash,1);
      expect((await work).buffer.equals(bytes)).toBe(true);expect(cloud).not.toHaveBeenCalled();
      expect(JSON.parse((await db.runtimeCostSample.findUniqueOrThrow({where:{id:key}})).sampleJson).count).toBe(4);
      expect((await db.phoneDispatchJob.findUniqueOrThrow({where:{id:job.jobId}})).resultJson).toBeNull();
    }finally{names.forEach((name,i)=>{if(previous[i]===undefined)delete process.env[name];else process.env[name]=previous[i];});}
  });
});
