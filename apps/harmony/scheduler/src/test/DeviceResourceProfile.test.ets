import { describe, expect, it } from '@ohos/hypium';
import { AppVisibility, Backend, DeviceState, DeviceStateSource, MemoryPressure, ThermalLevel } from '../main/ets/api/SchedulerTypes';
import { deviceResourceProfile } from '../main/ets/state/DeviceResourceProfile';

export default function deviceResourceProfileTests():void {
  describe('DeviceResourceProfile',()=>{
    it('preserves per-field freshness instead of refreshing resources with heartbeat time',0,()=>{
      const sampled:Record<string,number>={};
      sampled['availableBackends']=1000;
      sampled['availableMemoryMb']=1000;
      sampled['systemCpuUsage']=1000;
      sampled['thermalLevel']=1000;
      const state:DeviceState={batteryPercent:80,isCharging:false,thermalLevel:ThermalLevel.NORMAL,
        appVisibility:AppVisibility.FOREGROUND,recentLatencyMs:null,queueDepth:0,systemCpuUsage:20,appCpuUsage:1,
        memoryPressure:MemoryPressure.NORMAL,totalMemoryMb:8192,freeMemoryMb:2048,availableMemoryMb:2048,
        availableBackends:[Backend.CPU],sampledAt:sampled,
        source:DeviceStateSource.REAL,capturedAt:5000};
      const fresh=deviceResourceProfile(state,['image.crop.v1'],1,2000);
      expect(fresh.availableMemoryMB).assertEqual(2048);
      expect(fresh.cpuUsage).assertEqual(20);
      const stale=deviceResourceProfile(state,['image.crop.v1'],1,5000);
      expect(stale.availableMemoryMB===null).assertTrue();
      expect(stale.cpuUsage===null).assertTrue();
      expect(stale.thermalLevel).assertEqual(ThermalLevel.NORMAL);
      state.source=DeviceStateSource.INJECTED;
      expect(deviceResourceProfile(state,['image.crop.v1'],1,2000).source).assertEqual('MOCK');
    });
  });
}
