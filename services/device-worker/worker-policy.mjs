import os from 'node:os';

/**
 * Worker微观调度策略
 * 
 * 职责:
 * 1. 资源准入决策 - 是否接受新任务
 * 2. 执行配置选择 - 决定线程数和内存分配
 * 3. 利用宏观上下文 - 根据urgency调整策略
 * 
 * 设计参考: Phone端的ConstrainedPolicy
 */
export class WorkerPolicy {
  constructor(config = {}) {
    this.maxSlots = config.maxSlots || 2;
    this.maxMemoryMB = config.maxMemoryMB || 4096;
    this.cpuThreshold = config.cpuThreshold || 0.8;
    this.maxQueueLength = config.maxQueueLength || 3;
    this.defaultThreads = config.defaultThreads || 4;
  }
  
  /**
   * 准入决策 - 是否接受新任务
   * 
   * @param task 任务需求 { memoryMB, capability }
   * @param state 当前Worker状态 { activeSlots, usedMemoryMB, cpuUsage, queueLength }
   * @param macroContext 宏观调度上下文 { urgency, baselineDevice }
   * @returns { allowed: boolean, reason: string }
   */
  admit(task, state, macroContext = {}) {
    // 硬约束1: 槽位满
    if (state.activeSlots >= this.maxSlots) {
      return { allowed: false, reason: 'SLOTS_FULL' };
    }
    
    // 硬约束2: 内存不足
    const requiredMemoryMB = task.memoryMB || 512;
    const availableMemoryMB = this.maxMemoryMB - state.usedMemoryMB;
    
    if (requiredMemoryMB > availableMemoryMB * 0.9) {
      return { allowed: false, reason: 'MEMORY_INSUFFICIENT' };
    }
    
    // 硬约束3: CPU高负载
    if (state.cpuUsage > this.cpuThreshold) {
      return { allowed: false, reason: 'CPU_HIGH_LOAD' };
    }
    
    // 软约束: 队列过长
    // 但如果是优化方案(baseline是Cloud)且用户在等,允许更长队列
    const isOptimization = macroContext.baselineDevice === 'cloud-runtime';
    const maxQueue = (isOptimization && macroContext.urgency) ? 
      this.maxQueueLength + 1 : this.maxQueueLength;
    
    if (state.queueLength >= maxQueue) {
      return { allowed: false, reason: 'QUEUE_TOO_LONG' };
    }
    
    return { 
      allowed: true, 
      reason: 'RESOURCE_AVAILABLE',
      score: this.calculateAdmissionScore(task, state, macroContext)
    };
  }
  
  /**
   * 配置选择 - 决定使用多少线程
   * 
   * @param task 任务需求
   * @param state 当前状态
   * @param macroContext 宏观上下文
   * @returns { threads: number, priority: string }
   */
  selectConfig(task, state, macroContext = {}) {
    const baseThreads = task.defaultThreads || this.defaultThreads;
    let threads = baseThreads;
    let priority = 'NORMAL';
    
    // 策略1: 如果用户在等,提高优先级和线程数
    if (macroContext.urgency) {
      threads = Math.min(os.cpus().length, baseThreads * 1.5);
      priority = 'HIGH';
    }
    
    // 策略2: 如果是优化方案,尽力完成
    if (macroContext.baselineDevice === 'cloud-runtime') {
      threads = Math.max(threads, baseThreads * 1.25);
      priority = priority === 'HIGH' ? 'CRITICAL' : 'HIGH';
    }
    
    // 策略3: 如果有其他任务在执行,降低线程数
    if (state.activeSlots > 0) {
      threads = Math.max(2, Math.floor(threads / (state.activeSlots + 1)));
    }
    
    // 策略4: 如果CPU已有压力,保守配置
    if (state.cpuUsage > 0.5) {
      threads = Math.max(2, Math.floor(threads * 0.75));
    }
    
    // 策略5: 不超过CPU核数
    threads = Math.min(threads, os.cpus().length);
    threads = Math.max(1, Math.floor(threads));
    
    return { 
      threads,
      priority,
      reason: this.explainConfig(threads, priority, macroContext)
    };
  }
  
  /**
   * 计算准入分数 - 用于多任务排序
   */
  calculateAdmissionScore(task, state, macroContext) {
    let score = 100;
    
    // 用户在等: +50
    if (macroContext.urgency) {
      score += 50;
    }
    
    // 优化方案: +30
    if (macroContext.baselineDevice === 'cloud-runtime') {
      score += 30;
    }
    
    // 当前负载越低,分数越高
    score -= state.activeSlots * 20;
    score -= state.cpuUsage * 50;
    
    return Math.max(0, score);
  }
  
  /**
   * 解释配置选择
   */
  explainConfig(threads, priority, macroContext) {
    const reasons = [];
    
    if (macroContext.urgency) {
      reasons.push('user_waiting');
    }
    
    if (macroContext.baselineDevice === 'cloud-runtime') {
      reasons.push('optimization_attempt');
    }
    
    reasons.push(`threads=${threads}`);
    reasons.push(`priority=${priority}`);
    
    return reasons.join(', ');
  }
  
  /**
   * 获取当前Worker状态
   * 应该由Worker主进程调用
   */
  static getCurrentState() {
    const totalMemoryMB = os.totalmem() / (1024 * 1024);
    const freeMemoryMB = os.freemem() / (1024 * 1024);
    const usedMemoryMB = totalMemoryMB - freeMemoryMB;
    
    // 简化的CPU使用率 (实际应该用更精确的方法)
    const loadAverage = os.loadavg()[0];
    const cpuCount = os.cpus().length;
    const cpuUsage = Math.min(1, loadAverage / cpuCount);
    
    return {
      activeSlots: global.activeTaskCount || 0,
      usedMemoryMB,
      cpuUsage,
      queueLength: global.taskQueueLength || 0,
      timestamp: Date.now()
    };
  }
}

/**
 * Worker执行器 - 集成微观调度策略
 */
export class WorkerExecutor {
  constructor(policy = new WorkerPolicy(), { runTask, getState } = {}) {
    this.taskRunner = runTask;
    this.stateProvider = getState;
    this.usedMemoryMB = 0;
    this.policy = policy;
    this.activeSlots = 0;
    this.taskQueue = [];
  }
  
  /**
   * 执行任务 - 带宏观上下文
   * 
   * @param request { task, macroContext }
   */
  async execute(request) {
    const { task, macroContext = {} } = request;
    
    // 1. 获取当前状态
    const state = this.getState(task);
    this.checkAdmission(task, macroContext, state);
    const admission = this.policy.admit(task, state, macroContext);

    // 3. 配置选择
    const config = this.policy.selectConfig(task, state, macroContext);
    
    console.log(
      `[WorkerExecutor] Admitted task ${task.id}: ` +
      `${config.reason}, score=${admission.score}`
    );
    
    // 4. 执行
    try {
      this.activeSlots++;
      this.usedMemoryMB += task.memoryMB || 512;
      const result = await this.runTask(task, config);
      return result;
    } finally {
      this.activeSlots--;
      this.usedMemoryMB -= task.memoryMB || 512;
    }
  }
  
  /**
   * 实际执行任务
   */
  getState(task) {
    return this.stateProvider ? this.stateProvider(task) : {
      ...WorkerPolicy.getCurrentState(), activeSlots: this.activeSlots,
      usedMemoryMB: this.usedMemoryMB, queueLength: this.taskQueue.length
    };
  }

  checkAdmission(task, macroContext = {}, state = this.getState(task)) {
    const admission = this.policy.admit(task, state, macroContext);
    if (!admission.allowed) {
      const error = new Error('CAPACITY_FULL');
      error.reason = admission.reason;
      throw error;
    }
  }

  async runTask(task, config) {
    if (!this.taskRunner) throw new Error('CAPABILITY_EXECUTOR_REQUIRED');
    return this.taskRunner(task, config);
  }
}
