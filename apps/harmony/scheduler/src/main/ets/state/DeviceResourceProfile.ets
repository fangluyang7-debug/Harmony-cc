import { DeviceState, DeviceStateSource, ThermalLevel } from '../api/SchedulerTypes';

export interface DeviceResourceProfile {
  networkId?: string;
  executorVersion?: string;
  resourceValidForMs: number;
  batteryPercent: number | null;
  isCharging: boolean | null;
  version: number;
  source: string;
  capabilities: string[];
  availableBackends: string[];
  availableSlots: number;
  availableMemoryMB: number | null;
  cpuUsage: number | null;
  cpuCores: number | null;
  thermalLevel: string;
  queueLength: number;
}

// Reuse the existing sampler and its per-field timestamps; sending a heartbeat does not refresh a sample.
export function deviceResourceProfile(state: DeviceState, capabilities: string[], availableSlots: number,
  now: number = Date.now()): DeviceResourceProfile {
  const fresh = (field: string, ttl: number): boolean => {
    const sampled = state.sampledAt?.[field];
    return state.source === DeviceStateSource.REAL && sampled !== undefined && sampled <= now && now - sampled <= ttl;
  };
  const remaining=(field:string,ttl:number):number => {
    const sampled=state.sampledAt?.[field];
    return sampled===undefined||sampled>now?0:Math.max(0,ttl-(now-sampled));
  };
  return { version: 1, source: state.source === DeviceStateSource.REAL ? 'REAL' : 'MOCK',
    resourceValidForMs:Math.min(remaining('availableMemoryMb',3000),remaining('systemCpuUsage',3000),remaining('thermalLevel',30000),remaining('availableBackends',30000)),
    batteryPercent:fresh('batteryPercent',30000)?state.batteryPercent:null,isCharging:fresh('isCharging',30000)?state.isCharging:null,
    capabilities: capabilities.slice(), availableBackends: fresh('availableBackends', 30000) ? state.availableBackends.slice() : [],
    availableSlots: availableSlots, availableMemoryMB: fresh('availableMemoryMb', 3000) ? state.availableMemoryMb : null,
    cpuUsage: fresh('systemCpuUsage', 3000) ? state.systemCpuUsage : null, cpuCores: null,
    thermalLevel: fresh('thermalLevel', 30000) ? state.thermalLevel : ThermalLevel.UNKNOWN, queueLength: state.queueDepth };
}
