import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../persistence/prisma/prisma.service';

export interface WorkerConnection {
  deviceId: string; endpoint: string; tokenEnv: string; enabled: boolean;
  qualityVerified: boolean; cropPriorMs: number;
}
export interface ResourceProfile {
  version: 1;
  source: 'REAL';
  capabilities: string[];
  availableBackends: string[];
  availableSlots: number;
  availableMemoryMB: number | null;
  cpuUsage: number | null;
  cpuCores: number | null;
  thermalLevel: string;
  queueLength: number;
}

export function validateResourceProfile(value: unknown): ResourceProfile {
  const p = value as ResourceProfile;
  const nonnegative = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!p || p.version !== 1 || p.source !== 'REAL' ||
      !Array.isArray(p.capabilities) || p.capabilities.length > 64 ||
      p.capabilities.some(c => typeof c !== 'string' || !/^[\w.-]{1,128}$/.test(c)) ||
      !Array.isArray(p.availableBackends) || p.availableBackends.length > 8 ||
      p.availableBackends.some(b => !['CPU','GPU','NPU'].includes(b)) ||
      !Number.isSafeInteger(p.availableSlots) || p.availableSlots < 0 || p.availableSlots > 64 ||
      (p.availableMemoryMB !== null && !nonnegative(p.availableMemoryMB)) ||
      (p.cpuUsage !== null && (!nonnegative(p.cpuUsage) || p.cpuUsage > 100)) ||
      (p.cpuCores !== null && (!Number.isSafeInteger(p.cpuCores) || p.cpuCores < 1 || p.cpuCores > 4096)) ||
      !['UNKNOWN','COOL','NORMAL','WARM','HOT','CRITICAL'].includes(p.thermalLevel) ||
      !Number.isSafeInteger(p.queueLength) || p.queueLength < 0 || p.queueLength > 10000) {
    throw new BadRequestException('DEVICE_PROFILE_INVALID');
  }
  return {version:1,source:'REAL',capabilities:[...new Set(p.capabilities)],availableBackends:[...new Set(p.availableBackends)],
    availableSlots:p.availableSlots,availableMemoryMB:p.availableMemoryMB,cpuUsage:p.cpuUsage,
    cpuCores:p.cpuCores,thermalLevel:p.thermalLevel,queueLength:p.queueLength};
}

export function validateWorkerConnection(value: unknown): WorkerConnection {
  const c = value as WorkerConnection;
  let url: URL;
  try { url = new URL(c.endpoint); } catch { throw new BadRequestException('DEVICE_ENDPOINT_INVALID'); }
  if (!/^[\w.-]{1,128}$/.test(c.deviceId) || c.deviceId === 'cloud-runtime' || c.deviceId.startsWith('phone_') ||
      !/^\w{1,128}$/.test(c.tokenEnv) || typeof c.enabled !== 'boolean' || typeof c.qualityVerified !== 'boolean' ||
      !Number.isFinite(c.cropPriorMs) || c.cropPriorMs <= 0 ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash) throw new BadRequestException('DEVICE_CONFIG_INVALID');
  return {...c,endpoint:c.endpoint.replace(/\/$/,'')};
}

@Injectable()
export class DeviceDirectoryService {
  constructor(private readonly prisma: PrismaService) {}

  async registerWorker(value: unknown) {
    const config = validateWorkerConnection(value);
    // Only the maintenance-authenticated endpoint may provision connection credentials.
    if (!process.env[config.tokenEnv] || process.env[config.tokenEnv]!.length < 32) throw new BadRequestException('DEVICE_CREDENTIAL_MISSING');
    await this.prisma.runtimeDevice.upsert({where:{id:config.deviceId},
      create:{id:config.deviceId,kind:'WORKER',ownerUserId:'',connectionJson:JSON.stringify(config),status:config.enabled?'active':'revoked'},
      update:{connectionJson:JSON.stringify(config),status:config.enabled?'active':'revoked',profileJson:null,observedAt:null}});
    return {deviceId:config.deviceId,status:config.enabled?'awaiting-heartbeat':'revoked'};
  }

  async heartbeatWorker(deviceId: string, authorization: unknown, profile: unknown) {
    const row = await this.prisma.runtimeDevice.findUnique({where:{id:deviceId}});
    if (!row || row.kind !== 'WORKER' || row.status !== 'active') throw new ForbiddenException('DEVICE_NOT_ACTIVE');
    const config = JSON.parse(row.connectionJson!) as WorkerConnection;
    const expected = 'Bearer ' + (process.env[config.tokenEnv] ?? '');
    if (!process.env[config.tokenEnv] || typeof authorization !== 'string' || Buffer.byteLength(authorization) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(authorization),Buffer.from(expected))) throw new ForbiddenException('DEVICE_AUTH_REQUIRED');
    const validated = validateResourceProfile(profile);
    await this.prisma.runtimeDevice.updateMany({where:{id:deviceId,status:'active'},data:{profileJson:JSON.stringify(validated),observedAt:new Date()}});
    return {deviceId,ttlMs:15000};
  }

  async reportPhone(workerUserId: string, deviceId: string, profile: unknown) {
    const device = await this.prisma.phoneDispatchDevice.findFirst({where:{id:deviceId,workerUserId,status:'active'}});
    if (!device) throw new ForbiddenException('DEVICE_NOT_OWNED');
    const validated = validateResourceProfile(profile);
    // A phone may only advertise installed adapters supported by this transport version.
    if (validated.capabilities.some(c=>!['image.crop.v1'].includes(c))) throw new BadRequestException('PHONE_CAPABILITY_UNSUPPORTED');
    await this.prisma.runtimeDevice.upsert({where:{id:deviceId},
      create:{id:deviceId,kind:'PHONE',ownerUserId:device.ownerUserId,status:'active',profileJson:JSON.stringify(validated),observedAt:new Date()},
      update:{profileJson:JSON.stringify(validated),observedAt:new Date()}});
    return {deviceId,ttlMs:15000};
  }

  async revoke(deviceId: string) {
    const result = await this.prisma.runtimeDevice.updateMany({where:{id:deviceId},data:{status:'revoked'}});
    if (!result.count) throw new ConflictException('DEVICE_NOT_REGISTERED');
    return {deviceId,status:'revoked'};
  }

  async workers(legacy: WorkerConnection[]): Promise<WorkerConnection[]> {
    const rows = await this.prisma.runtimeDevice.findMany({where:{kind:'WORKER'},take:256});
    const merged = new Map(legacy.map(c=>[c.deviceId,c]));
    for (const row of rows) {
      merged.delete(row.id); // Revocation or stale heartbeat also overrides the legacy configuration.
      if (row.status === 'active' && row.observedAt && Date.now()-row.observedAt.getTime() < 15000) {
        merged.set(row.id,validateWorkerConnection(JSON.parse(row.connectionJson!)));
      }
    }
    return [...merged.values()].filter(c=>c.enabled);
  }

  async phones(ownerUserId: string) {
    const rows = await this.prisma.runtimeDevice.findMany({where:{kind:'PHONE',ownerUserId,status:'active',observedAt:{gt:new Date(Date.now()-15000)}},take:32});
    const paired = await this.prisma.phoneDispatchDevice.findMany({where:{ownerUserId,status:'active',id:{in:rows.map(r=>r.id)}}});
    return rows.filter(r=>paired.some(p=>p.id===r.id)).map(r=>({deviceId:r.id,observedAt:r.observedAt!.getTime(),profile:validateResourceProfile(JSON.parse(r.profileJson!))}));
  }

  async list() {
    const rows = await this.prisma.runtimeDevice.findMany({take:256,orderBy:{id:'asc'}});
    return rows.map(r=>({deviceId:r.id,kind:r.kind,status:r.status,online:r.status==='active'&&!!r.observedAt&&Date.now()-r.observedAt.getTime()<15000,
      observedAt:r.observedAt,profile:r.profileJson?JSON.parse(r.profileJson):null}));
  }
}
