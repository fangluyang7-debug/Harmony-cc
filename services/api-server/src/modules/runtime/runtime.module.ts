import { CapabilityQualityRegistry } from '../../core/runtime/capability-quality-registry';
import { createCapabilityQualityRegistry } from '../../core/capabilities/quality-registry';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { RuntimeCostStore } from '../../core/runtime/runtime-cost-store';
import { DeviceCalibrationController } from './controllers/device-calibration.controller';
import { DeviceDirectoryController } from './controllers/device-directory.controller';
import { DeviceDirectoryService } from '../../core/runtime/device-directory.service';
import { PhoneDispatchController } from './controllers/phone-dispatch.controller';
import { PhoneDispatchService } from './phone-dispatch.service';
import { DeviceDispatchService } from '../../core/runtime/device-dispatch.service';
import { AuthModule } from '../auth/auth.module';
import { RuntimeMaintenanceGuard } from './runtime-maintenance.guard';
import { RuntimeProbeController } from './controllers/runtime-probe.controller';
import { MacroSchedulerService } from '../../core/runtime/macro-scheduler.service';
import { Injectable, Module, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AgentRuntimeService } from "../../core/runtime/agent-runtime.service";
import { CloudPlatformAdapterService } from "../../core/runtime/cloud-platform-adapter.service";
import { CixP1PlatformAdapterService, HarmonyPlatformAdapterService } from "../../core/runtime/unavailable-platform-adapters.service";
import { HostPlatformAdapterService } from "../../core/runtime/host-platform-adapter.service";
import { PerformanceRegistryService } from "../../core/runtime/performance-registry.service";
import { PlatformDiscoveryService } from "../../core/runtime/platform-discovery.service";
import { ResourceAwareSchedulerService } from "../../core/runtime/scheduler.service";
import { RuntimeSnapshotService } from "../../core/runtime/runtime-snapshot.service";
import { TelemetryService } from "../../core/runtime/telemetry.service";
import { ToolRegistryService } from "../../core/runtime/tool-registry.service";
import { RuntimeRunService } from "../../core/runtime/runtime-run.service";
import { RuntimeEventBusService } from "../../core/runtime/runtime-event-bus.service";
import { createShoppingPlugin } from "../../core/runtime/shopping-plugin";
import { RuntimeController } from "./controllers/runtime.controller";
import { ExecutorRegistryService } from '../../core/runtime/executor-registry.service';
import { RuntimeRunnerService } from '../../core/runtime/runtime-runner.service';
import { CloudReadinessService } from '../../core/runtime/cloud-readiness.service';
import { TencentCosStorageAdapterService } from '../../adapters/storage/tencent-cos-storage-adapter.service';

@Injectable()
class ShoppingPluginRegistration implements OnModuleInit {
  constructor(
    private readonly config: ConfigService,
    private readonly registry: ToolRegistryService,
  ) {}

  onModuleInit() {
    this.registry.registerPlugin(createShoppingPlugin(this.config));
  }
}

@Module({
  imports: [AuthModule],
  controllers: [DeviceDirectoryController, DeviceCalibrationController, PhoneDispatchController, RuntimeController, RuntimeProbeController],
  providers: [{provide:CapabilityQualityRegistry,useFactory:createCapabilityQualityRegistry,inject:[PrismaService]}, RuntimeCostStore, DeviceDirectoryService, DeviceDispatchService, PhoneDispatchService, RuntimeMaintenanceGuard,
    MacroSchedulerService,
    ExecutorRegistryService, RuntimeRunnerService, CloudReadinessService, TencentCosStorageAdapterService,
    ToolRegistryService,
    PerformanceRegistryService,
    TelemetryService,
    HostPlatformAdapterService,
    HarmonyPlatformAdapterService,
    CixP1PlatformAdapterService,
    CloudPlatformAdapterService,
    PlatformDiscoveryService,
    ResourceAwareSchedulerService,
    RuntimeSnapshotService,
    RuntimeRunService,
    RuntimeEventBusService,
    AgentRuntimeService,
    ShoppingPluginRegistration,
  ],
  exports: [CapabilityQualityRegistry, RuntimeCostStore, DeviceDirectoryService, DeviceDispatchService, PhoneDispatchService,
    MacroSchedulerService,
    ExecutorRegistryService, RuntimeRunnerService, CloudReadinessService,
    ToolRegistryService,
    PerformanceRegistryService,
    TelemetryService,
    ResourceAwareSchedulerService,
    AgentRuntimeService,
    RuntimeRunService,
    RuntimeEventBusService,
  ],
})
export class RuntimeModule {}
