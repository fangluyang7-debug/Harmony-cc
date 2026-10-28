import { IMAGE_CROP_CONTRACT } from '../../core/capabilities/image-crop-contract';
import { RuntimeCostStore, costKey, networkIdentity, canonical } from '../../core/runtime/runtime-cost-store';
import { CapabilityQualityRegistry } from '../../core/runtime/capability-quality-registry';
import { createCapabilityQualityRegistry } from '../../core/capabilities/quality-registry';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, Optional } from '@nestjs/common';
import { DeviceDirectoryService } from '../../core/runtime/device-directory.service';
import { DispatchOptions } from '../../core/runtime/device-dispatch.service';
import { SchedulingDecision } from '../../core/runtime/macro-scheduler.service';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import sharp = require('sharp');
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { QueryImageCropResult } from '../sessions/application/query-image-content-adapter.interface';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const LEASE_MS = 60_000;
const CROP_WAIT_MS = 25_000;

export interface TerminalTiming {version:1;executorVersion:string;executionMs:number;inputTransferMs:number;networkId?:string;}

export interface CropInput {
  executorVersion?:string;
  macroContext?: SchedulingDecision['macroContext'];
  imageUrl: string;
  inputHash: string;
  region: { left: number; top: number; width: number; height: number };
  targetSize: number;
  jpegQuality: number;
  original: { width: number; height: number; format: string | null };
}

function fixture(): number[][] {
  return Array.from({ length: 512 }, (_, i) =>
    Array.from({ length: 8 }, (_, j) => ((i * 37 + j * 19) % 997 - 498) / 10));
}

@Injectable()
export class PhoneDispatchService {
  constructor(private readonly prisma: PrismaService,@Optional() private readonly directory?:DeviceDirectoryService,
    @Optional() sharedCostStore?:RuntimeCostStore,@Optional() qualityRegistry?:CapabilityQualityRegistry) {this.costStore=sharedCostStore??RuntimeCostStore.shared(this.prisma);this.qualityRegistry=qualityRegistry??createCapabilityQualityRegistry(this.prisma);}

  private readonly costStore:RuntimeCostStore;
  private readonly qualityRegistry:CapabilityQualityRegistry;

  async reportProfile(workerUserId:string,deviceId:string,profile:unknown) {
    this.enabled();
    if (!this.directory) throw new ServiceUnavailableException('DEVICE_DIRECTORY_UNAVAILABLE');
    return this.directory.reportPhone(workerUserId,deviceId,profile);
  }

  async cropAdapters(ownerUserId:string,imageUrl:string,imageBytes:Buffer,
    parameters:Parameters<PhoneDispatchService['cropForShopping']>[3]):Promise<NonNullable<DispatchOptions['remoteExecutors']>> {
    if (!this.directory || process.env.PHONE_DISPATCH_EXPERIMENT_ENABLED !== 'true') return [];
    const profiles=await this.directory.phones(ownerUserId);
    const result:NonNullable<DispatchOptions['remoteExecutors']>=[];
    for(const device of profiles) {
      const p=device.profile;
      if (!p.capabilities.includes('image.crop.v1') || !p.availableBackends.includes('CPU') || p.availableSlots<1 || p.availableMemoryMB===null ||
          ['HOT','CRITICAL','UNKNOWN'].includes(p.thermalLevel) || p.cpuUsage===null || p.cpuUsage>90) continue;
      const active=await this.prisma.phoneDispatchJob.count({where:{deviceId:device.deviceId,state:{in:['PENDING','LEASED','STOP_REQUESTED']}}});
      if(active)continue;
      const executorVersion=p.executorVersion??'1',networkId=networkIdentity(p.networkId);
      const key=this.phoneSampleKey(device.deviceId,imageBytes.length,parameters,executorVersion,networkId);
      const measured=await this.costStore.get(key);
      const qualityApproved=await this.qualityRegistry.approved('image.crop.v1',device.deviceId,executorVersion);
      const route=this.transportRoute(imageUrl,networkId);
      const upload=this.costStore.link(device.deviceId,'upload',route.networkId);
      const relay=this.costStore.link(device.deviceId,'relay-return',route.networkId);
      const links=[];
      if(upload)links.push({from:route.sourceId,to:device.deviceId,...upload,effective:false,source:'REAL' as const});
      if(relay)links.push({from:device.deviceId,to:'cloud-runtime',...relay,effective:false,source:'REAL' as const});
      result.push({links,inputLocations:[{contentHash:createHash('sha256').update(imageBytes).digest('hex'),deviceId:route.sourceId}],candidate:{deviceId:device.deviceId,deviceType:'PHONE',connectionMode:'POLL_RELAY',executorId:'harmony-har',
        executorVersion,networkId,contractQuality:qualityApproved?1:null,capabilities:['image.crop.v1'],trusted:true,observedAt:device.observedAt,ttlMs:p.resourceValidForMs??3000,costScope:'execution',
        resourceSnapshot:{availableSlots:p.availableSlots,availableMemoryMB:p.availableMemoryMB,queueLength:p.queueLength},
        history:{quality:qualityApproved?1:null,meanMs:measured?.count?measured.mean:1000,stddevMs:measured?.count?Math.max(2*measured.deviation,measured.mean*.15):5000,sampleCount:measured?.count??0}},
        execute:async request=>{
          if(request.inputs.length!==1||request.inputs[0].contentHash!==createHash('sha256').update(imageBytes).digest('hex')||canonical(request.task.parameters)!==canonical(parameters))throw new Error('TERMINAL_ADAPTER_INPUT_MISMATCH');
          const start=performance.now();
          const source=request.macroContext.selectedReason==='BACKGROUND_CALIBRATION'?'CALIBRATION':'BUSINESS';
          try {
            const value=await this.cropForShopping(ownerUserId,imageUrl,imageBytes,parameters,request.signal,device.deviceId,request.macroContext,executorVersion);
            if(!value)throw new Error('PHONE_ADMISSION_REJECTED');
            this.recordMeasured(device.deviceId,imageBytes,parameters,executorVersion,networkId,imageUrl,performance.now()-start,value,source);
            return value.result;
          } catch(error) {
            this.costStore.record(key,performance.now()-start,false,undefined,source,(error as Error).message);
            throw error;
          }

        }});
    }
    return result;
  }
  private phoneSampleKey(deviceId:string,bytes:number,parameters:unknown,executorVersion='1',networkId='unknown'):string {
    return costKey('image.crop.v1',deviceId,bytes,parameters,'execution',executorVersion,networkId,IMAGE_CROP_CONTRACT.costModel);
  }

  private transportRoute(imageUrl:string,networkId:string) {
    const sourceId='object-store:'+hash(new URL(imageUrl).origin);
    return {sourceId,networkId:networkId==='unknown'?'unknown:'+sourceId:hash(networkId+':'+sourceId+':poll-relay-v1')};
  }
  private validTiming(value:TerminalTiming):boolean {
    return value.version===1&&typeof value.executorVersion==='string'&&value.executorVersion.length>0&&
      [value.executionMs,value.inputTransferMs].every(n=>Number.isFinite(n)&&n>=0&&n<=LEASE_MS);
  }
  private recordMeasured(deviceId:string,input:Buffer,parameters:unknown,executorVersion:string,networkId:string,imageUrl:string,total:number,
    value:{result:QueryImageCropResult;timing?:TerminalTiming},source:'BUSINESS'|'CALIBRATION'):void {
    this.costStore.record(costKey('image.crop.v1',deviceId,input.length,parameters,'roundtrip',executorVersion,networkId,IMAGE_CROP_CONTRACT.costModel),total,true,undefined,source);
    const timing=value.timing;
    // Old clients report a combined computedMs, so never reinterpret it as pure computation.
    if(!timing||!this.validTiming(timing)||timing.executorVersion!==executorVersion||timing.executionMs+timing.inputTransferMs>total)return;
    this.costStore.record(this.phoneSampleKey(deviceId,input.length,parameters,executorVersion),timing.executionMs,true,undefined,source);
    if(networkIdentity(timing.networkId)!==networkId)return;
    const route=this.transportRoute(imageUrl,networkId);
    this.costStore.record(costKey('',deviceId,0,{},'upload','',route.networkId),timing.inputTransferMs,true,input.length,source);
    // The remainder includes polling, queueing, encoding, result upload, DB settlement
    // and result consumption. It is not a pure bandwidth measurement; price it once.
    this.costStore.record(costKey('',deviceId,0,{},'relay-return','',route.networkId),total-timing.executionMs-timing.inputTransferMs,true,value.result.buffer.length,source);
  }

  // Maintenance-only fixed-fixture calibration; it does not require prior quality evidence.
  // Pairing, ownership, resource admission and result verification still apply.
  async calibrateCrop(ownerUserId:string,deviceId:string,imageUrl:string,imageBytes:Buffer,
    parameters:Parameters<PhoneDispatchService['cropForShopping']>[3],signal:AbortSignal,expectedExecutorVersion:string):Promise<Buffer> {
    const device=(await this.directory?.phones(ownerUserId))?.find(d=>d.deviceId===deviceId);
    if(!device)throw new Error('DEVICE_NOT_REGISTERED');
    if((device.profile.executorVersion??'1')!==expectedExecutorVersion)throw new Error('CALIBRATION_EXECUTOR_VERSION_MISMATCH');
    await this.costStore.consumeCalibration(ownerUserId,deviceId);
    const key=this.phoneSampleKey(deviceId,imageBytes.length,parameters,expectedExecutorVersion,networkIdentity(device.profile.networkId));
    const began=performance.now();
    try {
      const value=await this.cropForShopping(ownerUserId,imageUrl,imageBytes,parameters,signal,deviceId,
        {baselineDevice:'cloud-runtime',selectedReason:'EXPLICIT_CALIBRATION',urgency:false,budgetMs:CROP_WAIT_MS},expectedExecutorVersion);
      if(!value)throw new Error('PHONE_ADMISSION_REJECTED');
      if(value.timing?.executorVersion!==expectedExecutorVersion)throw new Error('CALIBRATION_EXECUTOR_VERSION_MISMATCH');
      this.recordMeasured(deviceId,imageBytes,parameters,expectedExecutorVersion,networkIdentity(device.profile.networkId),imageUrl,performance.now()-began,value,'CALIBRATION');
      return value.result.buffer;
    }catch(error){
      this.costStore.record(key,performance.now()-began,false,undefined,'CALIBRATION',(error as Error).message);
      throw error;
    }finally{await this.costStore.flush();}
  }

  private enabled(): void {
    if (process.env.PHONE_DISPATCH_EXPERIMENT_ENABLED !== 'true') {
      throw new ServiceUnavailableException('PHONE_DISPATCH_EXPERIMENT_DISABLED');
    }
  }

  async createPairing(ownerUserId: string) {
    this.enabled();
    const active = await this.prisma.phoneDispatchPairing.count({
      where: { ownerUserId, claimedAt: null, expiresAt: { gt: new Date() } },
    });
    if (active >= 3) throw new ConflictException('PAIRING_LIMIT_REACHED');
    const code = randomBytes(18).toString('base64url');
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await this.prisma.phoneDispatchPairing.create({
      data: { id: randomUUID(), ownerUserId, codeHash: hash(code), expiresAt },
    });
    return { code, expiresAt: expiresAt.toISOString() };
  }

  async claimPairing(workerUserId: string, code: string) {
    this.enabled();
    if (!/^[A-Za-z0-9_-]{24}$/.test(code)) throw new BadRequestException('PAIRING_CODE_INVALID');
    const codeHash = hash(code), now = new Date();
    const pairing = await this.prisma.phoneDispatchPairing.findUnique({ where: { codeHash } });
    if (!pairing || pairing.claimedAt || pairing.expiresAt <= now || pairing.ownerUserId === workerUserId) {
      throw new ForbiddenException('PAIRING_UNAVAILABLE');
    }
    const deviceId = 'phone_' + randomUUID();
    await this.prisma.$transaction(async tx => {
      const claimed = await tx.phoneDispatchPairing.updateMany({
        where: { id: pairing.id, claimedAt: null, expiresAt: { gt: now } },
        data: { claimedAt: now },
      });
      if (claimed.count !== 1) throw new ConflictException('PAIRING_ALREADY_CLAIMED');
      await tx.phoneDispatchDevice.create({
        data: { id: deviceId, ownerUserId: pairing.ownerUserId, workerUserId },
      });
    });
    return { deviceId, ownerUserId: pairing.ownerUserId };
  }

  async devices(ownerUserId: string) {
    this.enabled();
    return this.prisma.phoneDispatchDevice.findMany({
      where: { ownerUserId, status: 'active' },
      select: { id: true, status: true, lastSeenAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' }, take: 8,
    });
  }

  async revoke(ownerUserId: string, deviceId: string) {
    this.enabled();
    const changed = await this.prisma.phoneDispatchDevice.updateMany({
      where: { id: deviceId, ownerUserId, status: 'active' }, data: { status: 'revoked' },
    });
    if (changed.count !== 1) throw new NotFoundException('DEVICE_NOT_FOUND');
    // A leased task is not physically settled merely because the device was revoked.
    await this.prisma.phoneDispatchJob.updateMany({
      where: { deviceId, state: 'LEASED' }, data: { state: 'STOP_REQUESTED' },
    });
    await this.prisma.phoneDispatchJob.updateMany({
      where: { deviceId, state: 'PENDING' }, data: { state: 'CANCELLED_SETTLED', finishedAt: new Date() },
    });
    return { deviceId, status: 'revoked' };
  }

  async submit(ownerUserId: string, deviceId: string) {
    this.enabled();
    const outstanding = await this.prisma.phoneDispatchJob.count({
      where: { ownerUserId, state: { in: ['PENDING', 'LEASED', 'STOP_REQUESTED'] } },
    });
    if (outstanding >= 3) throw new ConflictException('JOB_LIMIT_REACHED');
    const device = await this.prisma.phoneDispatchDevice.findFirst({
      where: { id: deviceId, ownerUserId, status: 'active' },
    });
    if (!device) throw new NotFoundException('DEVICE_NOT_FOUND');
    const inputJson = JSON.stringify(fixture());
    const job = await this.prisma.phoneDispatchJob.create({
      data: { id: 'phonejob_' + randomUUID(), ownerUserId, workerUserId: device.workerUserId,
        deviceId, state: 'PENDING', inputJson, inputHash: hash(inputJson) },
    });
    return this.publicJob(job);
  }

  // An explicit, off-by-default demo route for a real shopping image. The worker
  // must be recently polling; otherwise the normal cloud crop remains available.
  async cropForShopping(ownerUserId: string, imageUrl: string, imageBytes: Buffer,
    parameters: { box: { x: number; y: number; width: number; height: number };
      paddingRatio: number; targetSize: number; jpegQuality: number }, signal: AbortSignal,
    selectedDeviceId?:string,macroContext?:SchedulingDecision['macroContext'],executorVersion?:string):
    Promise<{ jobId: string; result: QueryImageCropResult; timing?:TerminalTiming } | null> {
    if ((!selectedDeviceId && process.env.PHONE_DISPATCH_SHOPPING_DEMO_ENABLED !== 'true') ||
        process.env.PHONE_DISPATCH_EXPERIMENT_ENABLED !== 'true') return null;
    this.enabled();
    if(selectedDeviceId&&this.directory&&!(await this.directory.phones(ownerUserId)).some(d=>d.deviceId===selectedDeviceId))return null;
    if (!/^https:\/\//.test(imageUrl) || imageUrl.length > 4096 || imageBytes.length > 8 * 1024 * 1024 ||
        !Number.isInteger(parameters.targetSize) || parameters.targetSize < 64 || parameters.targetSize > 1024) return null;
    const device = await this.prisma.phoneDispatchDevice.findFirst({
      where: { ownerUserId, ...(selectedDeviceId?{id:selectedDeviceId}:{}), status: 'active', lastSeenAt: { gt: new Date(Date.now() - 10_000) } },
      orderBy: { lastSeenAt: 'desc' },
    });
    if (!device) return null;
    const active = await this.prisma.phoneDispatchJob.count({
      where: { deviceId: device.id, state: { in: ['PENDING', 'LEASED', 'STOP_REQUESTED'] } },
    });
    if (active > 0) return null;
    const metadata = await sharp(imageBytes, { limitInputPixels: 16 * 1024 * 1024 }).metadata();
    if (!metadata.width || !metadata.height) return null;
    const width = metadata.width, height = metadata.height, box = parameters.box;
    const cx = (box.x + box.width / 2) * width, cy = (box.y + box.height / 2) * height;
    const side = Math.min(Math.max(box.width * width, box.height * height) *
      (1 + parameters.paddingRatio * 2), Math.max(width, height));
    const left = Math.max(0, Math.min(width - 1, Math.round(cx - side / 2)));
    const top = Math.max(0, Math.min(height - 1, Math.round(cy - side / 2)));
    const right = Math.max(left + 1, Math.min(width, Math.round(cx + side / 2)));
    const bottom = Math.max(top + 1, Math.min(height, Math.round(cy + side / 2)));
    const input: CropInput = {
      macroContext,executorVersion,
      imageUrl, inputHash: '',
      region: { left, top, width: right - left, height: bottom - top },
      targetSize: parameters.targetSize, jpegQuality: parameters.jpegQuality,
      original: { width, height, format: metadata.format ?? null },
    };
    // Hash raw bytes, not a signed URL whose query string can rotate.
    input.inputHash = createHash('sha256').update(imageBytes).digest('hex');
    const job = await this.prisma.phoneDispatchJob.create({
      data: { id: 'phonejob_' + randomUUID(), ownerUserId, workerUserId: device.workerUserId,
        deviceId: device.id, state: 'PENDING', kind: 'image.crop.v1',
        inputJson: JSON.stringify(input), inputHash: input.inputHash },
    });
    const deadline = Date.now() + Math.min(CROP_WAIT_MS,macroContext?.budgetMs??CROP_WAIT_MS);
    try {
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        const current = await this.prisma.phoneDispatchJob.findUniqueOrThrow({ where: { id: job.id } });
        if (current.state === 'COMPLETED' && current.resultJson) {
          const stored = JSON.parse(current.resultJson) as { imageBase64: string; timing?:TerminalTiming };
          const bytes = Buffer.from(stored.imageBase64, 'base64');
          if (createHash('sha256').update(bytes).digest('hex') !== current.resultHash) {
            throw new Error('PHONE_CROP_RESULT_HASH_MISMATCH');
          }
          await this.prisma.phoneDispatchJob.update({ where: { id: job.id },
            data: { inputJson: '{}', resultJson: null } });
          return { jobId: job.id, timing:stored.timing, result: {
            buffer: bytes, metadata: input.original, cropRegionPx: input.region,
            strategy: 'phone_crop_demo_' + device.id,
          } };
        }
        if (['FAILED', 'CANCELLED_SETTLED'].includes(current.state)) throw new Error('PHONE_CROP_FAILED');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error('PHONE_CROP_TIMEOUT');
    } catch (error) {
      await this.cancel(ownerUserId, job.id);
      await this.prisma.phoneDispatchJob.update({ where: { id: job.id },
        data: { inputJson: '{}', resultJson: null } });
      throw error;
    }
  }

  async get(ownerUserId: string, jobId: string) {
    this.enabled();
    const job = await this.prisma.phoneDispatchJob.findFirst({ where: { id: jobId, ownerUserId } });
    if (!job) throw new NotFoundException('JOB_NOT_FOUND');
    return this.publicJob(job);
  }

  async cancel(ownerUserId: string, jobId: string) {
    this.enabled();
    const job = await this.prisma.phoneDispatchJob.findFirst({ where: { id: jobId, ownerUserId } });
    if (!job) throw new NotFoundException('JOB_NOT_FOUND');
    if (job.state === 'PENDING') {
      await this.prisma.phoneDispatchJob.updateMany({
        where: { id: jobId, state: 'PENDING' },
        data: { state: 'CANCELLED_SETTLED', finishedAt: new Date() },
      });
    } else if (job.state === 'LEASED') {
      await this.prisma.phoneDispatchJob.updateMany({
        where: { id: jobId, state: 'LEASED' }, data: { state: 'STOP_REQUESTED' },
      });
    }
    return this.get(ownerUserId, jobId);
  }

  async lease(workerUserId: string, deviceId: string) {
    this.enabled();
    const device = await this.prisma.phoneDispatchDevice.findFirst({
      where: { id: deviceId, workerUserId },
    });
    if (!device) throw new ForbiddenException('DEVICE_NOT_OWNED');
    await this.prisma.phoneDispatchDevice.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } });
    // Expiry requests a stop; it cannot claim that execution has physically ended.
    await this.prisma.phoneDispatchJob.updateMany({
      where: { workerUserId, deviceId, state: 'LEASED', leaseUntil: { lt: new Date() } },
      data: { state: 'STOP_REQUESTED' },
    });
    const stop = await this.prisma.phoneDispatchJob.findFirst({
      where: { workerUserId, deviceId, state: 'STOP_REQUESTED' }, orderBy: { createdAt: 'asc' },
    });
    if (stop) return { job: null, stopJobId: stop.id, fence: stop.fence };
    const active = await this.prisma.phoneDispatchJob.findFirst({
      where: { workerUserId, deviceId, state: 'LEASED' }, select: { id: true },
    });
    if (active) return { job: null, stopJobId: null };
    if (device.status !== 'active') return { job: null, stopJobId: null };
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = await this.prisma.phoneDispatchJob.findFirst({
        where: { workerUserId, deviceId, state: 'PENDING' }, orderBy: { createdAt: 'asc' },
      });
      if (!candidate) return { job: null, stopJobId: null };
      const now = new Date();
      const cropInput=candidate.kind==='image.crop.v1'?JSON.parse(candidate.inputJson) as CropInput:null;
      const remaining=cropInput?.macroContext?cropInput.macroContext.budgetMs-(now.getTime()-candidate.createdAt.getTime()):LEASE_MS;
      if (remaining<=0) {
        await this.prisma.phoneDispatchJob.updateMany({where:{id:candidate.id,state:'PENDING'},data:{state:'CANCELLED_SETTLED',finishedAt:now}});
        continue;
      }
      const leaseUntil = new Date(now.getTime() + Math.min(LEASE_MS,remaining));
      if(cropInput?.macroContext)cropInput.macroContext.budgetMs=remaining;
      let updated;
      try {
        updated = await this.prisma.phoneDispatchJob.updateMany({
          where: { id: candidate.id, state: 'PENDING' },
          data: { state: 'LEASED', fence: { increment: 1 }, leasedAt: now, leaseUntil },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          return { job: null, stopJobId: null };
        }
        throw error;
      }
      if (updated.count === 1) return { job: { jobId: candidate.id, kind: candidate.kind,
        ...(candidate.kind === 'image.crop.v1'
          ? { crop: cropInput }
          : { rows: JSON.parse(candidate.inputJson) }),
        inputHash: candidate.inputHash, fence: candidate.fence + 1, deadlineAt: leaseUntil.toISOString() },
        stopJobId: null };
    }
    return { job: null, stopJobId: null };
  }

  async result(workerUserId: string, deviceId: string, jobId: string, fence: number,
    norms: number[], computedMs: number) {
    this.enabled();
    if (!Number.isSafeInteger(fence) || fence < 1 || !Number.isSafeInteger(computedMs) ||
        computedMs < 0 || computedMs > LEASE_MS ||
        !Array.isArray(norms) || norms.length !== 512 || !norms.every(Number.isFinite)) {
      throw new BadRequestException('RESULT_INVALID');
    }
    const job = await this.prisma.phoneDispatchJob.findFirst({ where: { id: jobId, workerUserId, deviceId } });
    if (!job) throw new NotFoundException('JOB_NOT_FOUND');
    if (job.kind !== 'vector.norm.demo') throw new BadRequestException('RESULT_KIND_INVALID');
    if (job.fence !== fence || !['LEASED', 'STOP_REQUESTED'].includes(job.state)) {
      throw new ConflictException('STALE_OR_REVOKED_LEASE');
    }
    if (job.state === 'STOP_REQUESTED' || !job.leaseUntil || job.leaseUntil.getTime() < Date.now()) {
      await this.prisma.phoneDispatchJob.updateMany({
        where: { id: jobId, fence, state: { in: ['LEASED', 'STOP_REQUESTED'] } },
        data: { state: 'CANCELLED_SETTLED', finishedAt: new Date() },
      });
      return this.publicJob((await this.prisma.phoneDispatchJob.findUniqueOrThrow({ where: { id: jobId } })));
    }
    const rows = JSON.parse(job.inputJson) as number[][];
    const matches = norms.every((norm, i) =>
      Math.abs(norm - Math.hypot(...rows[i])) <= 1e-8 * Math.max(1, Math.hypot(...rows[i])));
    const updated = await this.prisma.phoneDispatchJob.updateMany({
      where: { id: jobId, fence, state: 'LEASED' },
      data: { state: matches ? 'COMPLETED' : 'FAILED', resultHash: matches ? hash(JSON.stringify(norms)) : null,
        computedMs, finishedAt: new Date() },
    });
    if (updated.count !== 1) throw new ConflictException('STALE_OR_REVOKED_LEASE');
    return this.publicJob((await this.prisma.phoneDispatchJob.findUniqueOrThrow({ where: { id: jobId } })));
  }

  async cropResult(workerUserId: string, deviceId: string, jobId: string, fence: number,
    imageBase64: string, inputHash: string, computedMs: number, timing?:TerminalTiming) {
    this.enabled();
    if (!Number.isSafeInteger(fence) || fence < 1 || !Number.isSafeInteger(computedMs) ||
        computedMs < 0 || computedMs > LEASE_MS || typeof imageBase64 !== 'string' ||
        imageBase64.length < 100 || imageBase64.length > 1_400_000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) throw new BadRequestException('CROP_RESULT_INVALID');
    const job = await this.prisma.phoneDispatchJob.findFirst({ where: { id: jobId, workerUserId, deviceId } });
    if (!job || job.kind !== 'image.crop.v1') throw new NotFoundException('JOB_NOT_FOUND');
    if (job.fence !== fence || !['LEASED', 'STOP_REQUESTED'].includes(job.state)) {
      throw new ConflictException('STALE_OR_REVOKED_LEASE');
    }
    if (job.state === 'STOP_REQUESTED' || !job.leaseUntil || job.leaseUntil.getTime() < Date.now()) {
      await this.prisma.phoneDispatchJob.updateMany({
        where: { id: jobId, fence, state: { in: ['LEASED', 'STOP_REQUESTED'] } },
        data: { state: 'CANCELLED_SETTLED', finishedAt: new Date() },
      });
      return this.publicJob(await this.prisma.phoneDispatchJob.findUniqueOrThrow({ where: { id: jobId } }));
    }
    if (inputHash !== job.inputHash) throw new BadRequestException('CROP_INPUT_HASH_MISMATCH');
    if(timing && (!this.validTiming(timing)||timing.executionMs+timing.inputTransferMs>Date.now()-job.createdAt.getTime()+50))throw new BadRequestException('TERMINAL_TIMING_INVALID');
    const input = JSON.parse(job.inputJson) as CropInput;
    if(input.executorVersion&&timing?.executorVersion!==input.executorVersion)throw new BadRequestException('TERMINAL_EXECUTOR_VERSION_MISMATCH');
    const bytes = Buffer.from(imageBase64, 'base64');
    if (bytes.length > 1_000_000 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      throw new BadRequestException('CROP_IMAGE_INVALID');
    }
    const metadata = await sharp(bytes, { limitInputPixels: 1024 * 1024 }).metadata();
    if (metadata.format !== 'jpeg' || metadata.width !== input.targetSize ||
        metadata.height !== input.targetSize) throw new BadRequestException('CROP_DIMENSION_INVALID');
    const updated = await this.prisma.phoneDispatchJob.updateMany({
      where: { id: jobId, fence, state: 'LEASED' },
      data: { state: 'COMPLETED', resultHash: createHash('sha256').update(bytes).digest('hex'),
        resultJson: JSON.stringify({ imageBase64,timing }), computedMs, finishedAt: new Date() },
    });
    if (updated.count !== 1) throw new ConflictException('STALE_OR_REVOKED_LEASE');
    return this.publicJob(await this.prisma.phoneDispatchJob.findUniqueOrThrow({ where: { id: jobId } }));
  }

  async cropFailure(workerUserId: string, deviceId: string, jobId: string, fence: number) {
    this.enabled();
    if (!Number.isSafeInteger(fence) || fence < 1) throw new BadRequestException('FENCE_INVALID');
    const job = await this.prisma.phoneDispatchJob.findFirst({ where: { id: jobId, workerUserId, deviceId } });
    if (!job || job.kind !== 'image.crop.v1') throw new NotFoundException('JOB_NOT_FOUND');
    if (job.fence !== fence || !['LEASED', 'STOP_REQUESTED'].includes(job.state)) {
      throw new ConflictException('STALE_OR_REVOKED_LEASE');
    }
    const state = job.state === 'STOP_REQUESTED' || !job.leaseUntil || job.leaseUntil.getTime() < Date.now()
      ? 'CANCELLED_SETTLED' : 'FAILED';
    const updated = await this.prisma.phoneDispatchJob.updateMany({
      where: { id: jobId, workerUserId, deviceId, fence, state: job.state },
      data: { state, finishedAt: new Date() },
    });
    if (updated.count !== 1) throw new ConflictException('STALE_OR_REVOKED_LEASE');
    return this.publicJob(await this.prisma.phoneDispatchJob.findUniqueOrThrow({ where: { id: jobId } }));
  }

  async acknowledgeStop(workerUserId: string, deviceId: string, jobId: string, fence: number) {
    this.enabled();
    const updated = await this.prisma.phoneDispatchJob.updateMany({
      where: { id: jobId, workerUserId, deviceId, fence, state: 'STOP_REQUESTED' },
      data: { state: 'CANCELLED_SETTLED', finishedAt: new Date() },
    });
    if (updated.count !== 1) throw new ConflictException('STOP_ACK_REJECTED');
    return { jobId, state: 'CANCELLED_SETTLED' };
  }

  private publicJob(job: { id: string; deviceId: string; state: string; fence: number;
    inputHash: string; resultHash: string | null; computedMs: number | null;
    createdAt: Date; leasedAt: Date | null; finishedAt: Date | null }) {
    return { jobId: job.id, deviceId: job.deviceId, state: job.state, fence: job.fence,
      inputHash: job.inputHash, resultHash: job.resultHash, computedMs: job.computedMs,
      createdAt: job.createdAt, leasedAt: job.leasedAt, finishedAt: job.finishedAt };
  }
}
