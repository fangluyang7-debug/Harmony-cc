import { DeviceState, DeviceStateSource, ThermalLevel } from '../api/SchedulerTypes';

export interface DeviceResourceProfile {
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
  return { version: 1, source: state.source === DeviceStateSource.REAL ? 'REAL' : 'MOCK',
    capabilities: capabilities.slice(), availableBackends: fresh('availableBackends', 30000) ? state.availableBackends.slice() : [],
    availableSlots: availableSlots, availableMemoryMB: fresh('availableMemoryMb', 3000) ? state.availableMemoryMb : null,
    cpuUsage: fresh('systemCpuUsage', 3000) ? state.systemCpuUsage : null, cpuCores: null,
    thermalLevel: fresh('thermalLevel', 30000) ? state.thermalLevel : ThermalLevel.UNKNOWN, queueLength: state.queueDepth };
}
