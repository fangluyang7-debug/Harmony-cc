import { Injectable, Logger } from '@nestjs/common';
import { WorkflowPlacementPlanner, PlacementRequest, PlacementNode, PlacementCandidate, PlacementArtifact, PlacementLink, PlannerAssignment, WorkflowPlacementDecision } from './workflow-placement-planner';
import { ArtifactRef, TaskContractV1, ModelCompatibility } from './scheduling-protocol';

/**
 * 任务图 - 通用DAG表示，不绑定具体业务
 */
export interface TaskGraph {
  workflowId?: string;
  capability: string; // 主capability (用于日志)
  inputs: Array<ArtifactRef & { data?: Uint8Array; sizeBytes?: number }>;
  tasks: TaskSpec[];
}

export interface TaskSpec {
  contract?: TaskContractV1;
  id: string;
  capability: string;
  dependencies: string[];
  inputs: string[]; // artifact IDs
  outputBytes: number;
  memoryMB: number;
  minQuality: number;
  parameters?: Record<string, unknown>;
  outputSchemaId?: string;
  estimatedMs?: number; // 冷启动参考
}

/**
 * 设备候选 - 动态查询结果
 */
export interface DeviceCandidate {
  models?: Record<string,ModelCompatibility>;
  costScope?: 'execution' | 'coordinator-roundtrip';
  deviceId: string;
  deviceType: 'CLOUD' | 'WORKER' | 'PHONE' | 'EDGE';
  executorId: string;
  capabilities: string[];
  trusted: boolean;
  observedAt: number;
  ttlMs: number;
  
  resourceSnapshot: {
    availableSlots: number;
    availableMemoryMB: number;
    queueLength: number;
    thermalLevel?: string;
    batteryPercent?: number;
  };
  
  taskHistory?: Record<string, NonNullable<DeviceCandidate['history']>>;
  history?: {
    quality: number;
    meanMs: number;
    stddevMs: number;
    sampleCount: number;
  };
}

export interface SchedulingContext {
  materializeOutputsAt?: string;
  links?: PlacementLink[];
  budgetMs: number;
  networkAllowed: boolean;
  privacyLevel: 'LOCAL_ONLY' | 'AUTHORIZED_REMOTE';
  localDeviceId?: string;
  finalDestination?: string;
  userWaiting: boolean;
  importance: number;
}

export interface SchedulingDecision {
  assignments: PlannerAssignment[];
  baselineAssignments: PlannerAssignment[];
  deviceId: string;
  executorId: string;
  estimatedMs: number;
  baseline: { deviceId: string; estimatedMs: number };
  suggestion: { deviceId: string; estimatedMs: number };
  reason: string;
  mode: 'BASELINE' | 'OPTIMIZED' | 'FALLBACK';
  planningMs: number;
  
  // 宏观上下文 - 传递给微观调度
  macroContext: {
    workflowId?: string;
    taskId?: string;
    attemptId?: string;
    baselineDevice: string;
    selectedReason: string;
    urgency: boolean;
    budgetMs: number;
  };
}

/**
 * 宏观调度器 - 核心算法通用化
 * 
 * 职责:
 * 1. 接收任意任务图 (不限于购物)
 * 2. 动态查询候选设备
 * 3. 调用WorkflowPlacementPlanner
 * 4. 返回设备分配决策
 * 
 * 不做的事:
 * 1. 不关心具体业务 (购物/翻译/分类)
 * 2. 不写死设备列表
 * 3. 不实现微观调度
 */
@Injectable()
export class MacroSchedulerService {
  private readonly logger = new Logger(MacroSchedulerService.name);
  private readonly planner = new WorkflowPlacementPlanner();
  
  /**
   * 核心调度方法 - 通用化
   * 
   * @param graph 任务DAG图 (可以是单节点或多节点)
   * @param candidates 候选设备列表 (动态查询，不写死)
   * @param context 任务上下文
   * @returns 设备分配决策
   */
  async schedule(
    graph: TaskGraph,
    candidates: DeviceCandidate[],
    context: SchedulingContext
  ): Promise<SchedulingDecision> {
    const startedAt = Date.now();
    
    this.logger.debug(
      `Scheduling ${graph.capability}: ` +
      `${graph.tasks.length} tasks, ${candidates.length} candidates`
    );
    
    // 1. 构建Planner输入
    const nodes = this.buildPlacementNodes(graph, candidates);
    const artifacts = this.locateArtifacts(graph.inputs);
    const links = context.links ?? [];
    
    // 2. 构建PlacementRequest
    const request: PlacementRequest = {
      nodes,
      artifacts,
      links,
      remainingBudgetMs: context.budgetMs,
      networkAllowed: context.networkAllowed,
      privacy: context.privacyLevel,
      localDeviceId: context.localDeviceId ?? 'cloud-runtime',
      now: Date.now(),
      committedNodeIds: [],
      committedArtifacts: [],
      finalDestination: context.finalDestination ?? 'cloud-runtime',
      materializeOutputsAt: context.materializeOutputsAt
    };
    
    // 3. 调用束搜索算法
    const decision = this.planner.plan(request);
    
    // 4. 应用门禁策略
    const authorized = this.applyGates(decision, context);
    
    const planningMs = Date.now() - startedAt;
    
    this.logger.log(
      `Scheduled ${graph.capability}: ` +
      `baseline=${decision.baseline?.[0]?.deviceId}, ` +
      `suggestion=${decision.suggestion?.[0]?.deviceId}, ` +
      `actual=${authorized.deviceId}, ` +
      `mode=${authorized.mode}, ` +
      `planning=${planningMs}ms`
    );
    
    return {
      ...authorized,
      planningMs,
      macroContext: {
        baselineDevice: decision.baseline?.[0]?.deviceId ?? 'cloud-runtime',
        selectedReason: authorized.reason,
        urgency: context.userWaiting,
        budgetMs: Math.max(0, context.budgetMs - planningMs)
      }
    };
  }
  
  /**
   * 构建PlacementNode - 不再写死购物阶段
   */
  private buildPlacementNodes(
    graph: TaskGraph,
    candidates: DeviceCandidate[]
  ): PlacementNode[] {
    const nodes: PlacementNode[] = [];
    
    for (const task of graph.tasks) {
      // 为每个任务筛选支持的候选
      const taskCandidates: PlacementCandidate[] = candidates
        .filter(c => c.capabilities.includes(task.capability) || c.capabilities.includes('*'))
        .map(c => this.buildCandidate(c, task));
      
      if (taskCandidates.length === 0) {
        this.logger.warn(
          `No candidates for task ${task.id} (capability: ${task.capability})`
        );
      }
      
      nodes.push({
        id: task.id,
        capability: task.capability,
        dependencies: task.dependencies,
        inputs: task.inputs,
        output: { id: task.id + '-output', bytes: task.outputBytes },
        baselineDeviceId: this.selectBaseline(taskCandidates),
        memoryBytes: task.memoryMB * 1024 * 1024,
        minimumQuality: task.minQuality,
        candidates: taskCandidates
        ,model: task.contract?.model
      });
    }
    
    return nodes;
  }
  
  /**
   * 构建候选设备 - 包含实时资源状态
   */
  private buildCandidate(
    device: DeviceCandidate,
    task: TaskSpec
  ): PlacementCandidate {
    const history = device.taskHistory?.[task.id] ?? device.history;
    return {
      deviceId: device.deviceId,
      costScope: device.costScope,
      model: device.models?.[task.capability],
      executorId: device.executorId,
      capability: task.capability,
      trusted: device.trusted,
      source: 'REAL',
      observedAt: device.observedAt,
      ttlMs: device.ttlMs,
      
      // 资源状态 (来自设备上报)
      availableSlots: device.resourceSnapshot.availableSlots,
      availableMemoryBytes: device.resourceSnapshot.availableMemoryMB * 1024 * 1024,
      
      // 性能预估 (来自历史样本)
      quality: history?.quality ?? null,
      computeMs: history?.meanMs ?? this.coldStartEstimate(device, task),
      queueMs: device.resourceSnapshot.queueLength * 100, // 简化估算: 每个排队任务100ms
      coldMs: history ? 0 : 50,
      uncertaintyMs: history?.stddevMs ?? (history?.meanMs ?? task.estimatedMs ?? 1000) * 0.2,
      publishMs: 0
    };
  }
  
  /**
   * 冷启动估算 - 基于设备类型和任务复杂度
   */
  private coldStartEstimate(device: DeviceCandidate, task: TaskSpec): number {
    const base = task.estimatedMs ?? 1000;
    const factor = {
      'CLOUD': 1.0,
      'WORKER': 1.2,
      'PHONE': 1.5,
      'EDGE': 1.3
    }[device.deviceType] ?? 1.5;
    
    return base * factor;
  }
  
  /**
   * 选择基线设备 - 最可靠的
   */
  private selectBaseline(candidates: PlacementCandidate[]): string {
    if (candidates.length === 0) {
      return 'cloud-runtime'; // 兜底
    }
    
    // 优先选择Cloud
    const cloud = candidates.find(c => c.deviceId === 'cloud-runtime');
    if (cloud) {
      return cloud.deviceId;
    }
    
    // 否则选择质量最高的
    const withQuality = candidates.filter(c => c.quality !== null);
    if (withQuality.length > 0) {
      return withQuality.reduce((best, curr) => 
        (curr.quality ?? 0) > (best.quality ?? 0) ? curr : best
      ).deviceId;
    }
    
    // 兜底: 第一个
    return candidates[0].deviceId;
  }
  
  /**
   * 定位数据副本
   */
  private locateArtifacts(artifacts: TaskGraph['inputs']): PlacementArtifact[] {
    // TODO: 实际应查询ArtifactStore
    // 这里简化: 假设所有数据都在云端
    return artifacts.map(a => ({
      id: a.artifactId,
      bytes: a.data?.byteLength ?? a.sizeBytes ?? 0,
      replicas: [{
        deviceId: 'cloud-runtime',
        readMs: 0
      }]
    }));
  }
  
  /**
   * 应用门禁策略
   * 
   * 关键修复: 比较整条工作流成本,而非只看首节点
   */
  private applyGates(
    decision: WorkflowPlacementDecision,
    context: SchedulingContext
  ): Omit<SchedulingDecision, 'planningMs' | 'macroContext'> {
    const baseline = decision.baseline;
    if (!baseline?.length || decision.baselineMs === null || !Number.isFinite(decision.baselineMs)) {
      throw new Error('NO_BASELINE_PLAN');
    }
    const suggestion = decision.suggestion;
    const baselineMs = decision.baselineMs;
    const suggestionMs = decision.suggestionMs;
    const usable = suggestion?.length === baseline.length && suggestionMs !== null &&
      Number.isFinite(suggestionMs) && suggestionMs <= context.budgetMs;
    const improvementMs = usable ? baselineMs - suggestionMs! : 0;
    const optimized = usable && improvementMs >= 10;
    const assignments = optimized ? suggestion! : baseline;
    return {
      assignments, baselineAssignments: baseline,
      deviceId: assignments[0].deviceId, executorId: assignments[0].executorId,
      estimatedMs: optimized ? suggestionMs! : baselineMs,
      baseline: { deviceId: baseline[0].deviceId, estimatedMs: baselineMs },
      suggestion: { deviceId: usable ? suggestion![0].deviceId : baseline[0].deviceId,
        estimatedMs: usable ? suggestionMs! : baselineMs },
      mode: optimized ? 'OPTIMIZED' : 'BASELINE',
      reason: !usable ? 'NO_VALID_SUGGESTION' : optimized ?
        `COST_REDUCTION_${Math.round(improvementMs)}ms` : `IMPROVEMENT_TOO_SMALL_${Math.round(improvementMs)}ms`
    };
  }
}
