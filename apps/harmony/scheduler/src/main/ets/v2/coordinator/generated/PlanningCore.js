// packages/scheduler-core/src/protocol-v1.ts
function compatibleModel(required, actual) {
  return required.modelId === actual.modelId && required.modelVersion === actual.modelVersion && required.embeddingKind === actual.embeddingKind && required.dimension > 0 && required.dimension === actual.dimension && required.dtype === actual.dtype && required.normalization === actual.normalization && required.preprocessVersion === actual.preprocessVersion && required.indexSpaceId === actual.indexSpaceId;
}

// packages/scheduler-core/src/protocol-v2.ts
function validWorkModelV2(model) {
  const fields = ["version", "parameters"];
  if (model && Object.keys(model).includes("inputBytes")) fields.push("inputBytes");
  if (model && Object.keys(model).includes("scale")) fields.push("scale");
  if (!exactV2(model, fields) || model.inputBytes !== void 0 && model.inputBytes !== "IGNORE" || !idV2(model.version) || !Array.isArray(model.parameters) || model.parameters.length > 16) return false;
  if (model.scale !== void 0 && (!exactV2(model.scale, ["parameter", "reference"]) || !model.parameters.some((p) => p.name === model.scale.parameter) || !Number.isFinite(model.scale.reference) || model.scale.reference <= 0)) return false;
  const names = [];
  for (const rule of model.parameters) {
    if (!objectV2(rule)) return false;
    const width = Object.keys(rule).indexOf("bucketWidth") >= 0;
    if (!exactV2(rule, width ? ["name", "bucketWidth"] : ["name"]) || typeof rule.name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(rule.name) || names.indexOf(rule.name) >= 0) return false;
    if (width && (typeof rule.bucketWidth !== "number" || !Number.isFinite(rule.bucketWidth) || rule.bucketWidth <= 0)) return false;
    names.push(rule.name);
  }
  return true;
}
function objectV2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactV2(value, names) {
  if (!objectV2(value)) return false;
  const keys = Object.keys(value);
  return keys.length === names.length && keys.every((key) => names.indexOf(key) >= 0);
}
function idV2(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

// packages/scheduler-core/src/resources-v2.ts
function exact(v, keys) {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === keys.length && Object.keys(v).every((k) => keys.includes(k));
}
function id(v) {
  return typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
}
function integer(v, min = 0) {
  return Number.isSafeInteger(v) && v >= min;
}
function nonnegative(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}
function sampleUsableV2(v, now, domain) {
  return nonnegative(now) && v.value !== null && v.sampledAt <= now && now - v.sampledAt <= v.ttlMs && (domain === "SIMULATED" ? v.source === "SIMULATED" || v.source === "PRIOR" : domain === "REAL" && ["MEASURED", "PRIOR"].includes(v.source));
}
function validModelManifestV2(v) {
  return exact(v, ["modelId", "version", "weightsHash", "preprocessVersion", "embeddingKind", "dimension", "dtype", "normalization"]) && [v.modelId, v.version, v.preprocessVersion, v.embeddingKind, v.dtype, v.normalization].every((s) => id(s)) && typeof v.weightsHash === "string" && /^[a-f0-9]{64}$/.test(v.weightsHash) && integer(v.dimension, 1);
}
function sameModelV2(a, b) {
  return a === null || b === null ? a === b : validModelManifestV2(a) && validModelManifestV2(b) && a.modelId === b.modelId && a.version === b.version && a.weightsHash === b.weightsHash && a.preprocessVersion === b.preprocessVersion && a.embeddingKind === b.embeddingKind && a.dimension === b.dimension && a.dtype === b.dtype && a.normalization === b.normalization;
}

// packages/scheduler-core/src/planner.ts
function poolOccupancyKey(deviceId, poolId, holderId) {
  return JSON.stringify([deviceId, poolId, holderId ?? null]);
}
function earliestFeasibleV2(occupancy, demands, earliest, duration) {
  let start = earliest;
  for (let i = 0; i <= occupancy.length; i++) {
    let move = start;
    for (const demand of demands) {
      const overlaps = occupancy.filter((o) => o.key === demand.key && o.end > start && o.start < start + duration);
      for (const time of [start, ...overlaps.map((o) => Math.max(start, o.start))]) {
        const active = overlaps.filter((o) => o.start <= time && o.end > time);
        if (active.reduce((sum, o) => sum + o.amount, 0) + demand.amount > demand.capacity) move = Math.max(move, Math.min(...active.map((o) => o.end)));
      }
    }
    if (move === start) return start;
    start = move;
  }
  return Infinity;
}
var WorkflowPlacementPlanner = class {
  constructor(limits, clock) {
    this.limits = limits;
    this.clock = clock;
    if (![limits.maxCandidates, limits.lookahead, limits.beamWidth].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 64) || ![limits.planningBudgetMs, limits.switchCostMs, limits.hysteresisMs].every((n) => Number.isFinite(n) && n >= 0)) throw new Error("PLANNER_CONFIG_INVALID");
  }
  plan(request) {
    const started = this.clock(), rejections = [];
    const candidateCounts = {};
    let truncated = 0;
    const result = (baseline2, suggestion, reason) => ({
      status: suggestion ? "ready" : "blocked",
      baseline: baseline2?.assignments ?? null,
      suggestion: suggestion?.assignments ?? null,
      baselineMs: baseline2?.cost ?? null,
      suggestionMs: suggestion?.cost ?? null,
      candidateCounts,
      rejections,
      truncated,
      planningMs: Math.max(0, this.clock() - started),
      reason
    });
    if (request.nodes.length > 64 || request.nodes.some((n) => n.candidates.length > 64) || request.links.length > 4096 || request.artifacts.length + request.committedArtifacts.length > 4096 || !Number.isFinite(request.now)) return result(null, null, "REQUEST_LIMIT_OR_CLOCK_INVALID");
    if (!Number.isFinite(request.remainingBudgetMs) || request.remainingBudgetMs <= 0) return result(null, null, "BUDGET_EXHAUSTED");
    if (request.nodes.some((n) => new Set(n.candidates.map((c) => c.targetId)).size !== n.candidates.length)) return result(null, null, "DUPLICATE_TARGET");
    const pending = request.nodes.filter((n) => !request.committedNodeIds.includes(n.id));
    const known = new Set(request.committedNodeIds);
    for (const node of pending) {
      if (known.has(node.id) || node.dependencies.some((id2) => !known.has(id2))) return result(null, null, "DEPENDENCY_ORDER_INVALID");
      known.add(node.id);
    }
    const initial = { assignments: [], cost: 0, ready: /* @__PURE__ */ new Map(), completed: new Map(request.committedNodeIds.map((id2) => [id2, 0])), occupancy: [...request.initialOccupancy ?? []], artifacts: new Map([...request.artifacts, ...request.committedArtifacts].map((a) => [a.id, a])) };
    const legal = /* @__PURE__ */ new Map();
    for (const node of pending) {
      const candidates = node.candidates.filter((c) => {
        const code = this.reject(node, c, request);
        if (code) {
          const sample = c.availability?.resourceWait;
          const delay = code === "RESOURCE_CAPACITY" && sample?.value ? sample.sampledAt + sample.value - request.now : 0;
          rejections.push({ targetId: c.targetId, nodeId: node.id, deviceId: c.deviceId, executorId: c.executorId, code, ...delay > 0 ? { retryAfterMs: delay } : {} });
        }
        return !code;
      }).sort((a, b) => a.computeMs + a.queueMs + a.coldMs + a.uncertaintyMs - (b.computeMs + b.queueMs + b.coldMs + b.uncertaintyMs) || a.targetId.localeCompare(b.targetId));
      candidateCounts[node.id] = candidates.length;
      const selected = candidates.slice(0, this.limits.maxCandidates);
      const baseline2 = candidates.find((c) => c.targetId === node.baselineTargetId);
      if (baseline2 && !selected.includes(baseline2)) selected[selected.length - 1] = baseline2;
      truncated += candidates.length - selected.length;
      legal.set(node.id, selected);
    }
    let baseline = initial;
    for (const node of pending) {
      const c = legal.get(node.id).find((c2) => c2.targetId === node.baselineTargetId);
      baseline = baseline && c ? this.extend(baseline, node, c, request) : null;
    }
    baseline = this.finish(baseline, pending, request);
    if (pending.length > this.limits.lookahead) return result(baseline, baseline, "LOOKAHEAD_LIMIT_BASELINE");
    let beam = [initial];
    for (const node of pending) {
      if (this.clock() - started >= this.limits.planningBudgetMs) return result(baseline, baseline, "PLANNING_BUDGET_BASELINE");
      const next = [];
      for (const state of beam) for (const c of legal.get(node.id)) {
        const rejected = { targetId: c.targetId, nodeId: node.id, deviceId: c.deviceId, executorId: c.executorId, code: "DATA_UNREACHABLE_OR_BUDGET" };
        const candidate = this.extend(state, node, c, request, rejected);
        if (candidate) next.push(candidate);
        else rejections.push(rejected);
      }
      beam = next.sort((a, b) => a.cost - b.cost || JSON.stringify(a.assignments).localeCompare(JSON.stringify(b.assignments))).slice(0, this.limits.beamWidth);
      if (!beam.length) return result(baseline, baseline, baseline ? "BASELINE_ONLY" : "NO_LEGAL_PLAN");
    }
    const choices = beam.map((b) => this.finish(b, pending, request)).filter((b) => b !== null).sort((a, b) => a.cost - b.cost);
    const best = choices[0] ?? baseline;
    if (baseline && best && baseline.cost - best.cost <= this.limits.switchCostMs + this.limits.hysteresisMs) return result(baseline, baseline, "INSUFFICIENT_SAVING");
    return result(baseline, best, best ? "LEGAL_SUGGESTION" : "NO_LEGAL_PLAN");
  }
  reject(node, c, r) {
    if (!c.trusted || !["REAL", "SIMULATED"].includes(r.domain) || c.source !== r.domain) return "UNTRUSTED_OR_WRONG_DOMAIN";
    if (r.recoveryFromDeviceId === c.deviceId) return "RECOVERY_PRIMARY_DEVICE";
    if (c.capability !== node.capability) return "CAPABILITY_UNSUPPORTED";
    if (node.serviceId !== c.serviceId) return "SERVICE_PLACEMENT_FORBIDDEN";
    if (node.dataScope === "LOCAL_ONLY" && c.deviceId !== r.localDeviceId || node.dataScope === "OWNER_SERVICE" && c.serviceId === void 0) return "DATA_SCOPE_FORBIDDEN";
    if (node.model && (!c.model || !compatibleModel(node.model, c.model))) return "MODEL_INDEX_MISMATCH";
    if (node.modelManifest !== void 0 && !sameModelV2(node.modelManifest, c.modelManifest ?? null)) return "MODEL_MANIFEST_MISMATCH";
    if (!Number.isFinite(c.ttlMs) || !Number.isFinite(c.observedAt) || c.observedAt > r.now || r.now - c.observedAt > c.ttlMs || c.ttlMs <= 0) return "OBSERVATION_EXPIRED";
    if (c.deviceId !== r.localDeviceId && (!r.networkAllowed || r.privacy === "LOCAL_ONLY")) return "TRANSFER_FORBIDDEN";
    const requiredMemory = c.requiredMemoryBytes ?? node.memoryBytes;
    if (!Number.isSafeInteger(requiredMemory) || requiredMemory < 0 || node.maxMemoryBytes !== void 0 && (!Number.isSafeInteger(node.maxMemoryBytes) || node.maxMemoryBytes < 0 || requiredMemory > node.maxMemoryBytes)) return "EXECUTOR_MEMORY_LIMIT";
    if (c.costEvidence && [c.computeMs, c.coldMs, c.uncertaintyMs, c.publishMs].some((n) => n === null || !Number.isFinite(n) || n < 0)) return "COST_UNKNOWN";
    const a = c.availability;
    if (a) {
      if (a.snapshotVersion !== r.snapshotVersion || a.targetId !== c.targetId || a.poolIds.length !== c.resourcePoolIds.length || !c.resourcePoolIds.every((id2) => a.poolIds.includes(id2))) return "AVAILABILITY_SCOPE_MISMATCH";
      if (!sampleUsableV2(a.resourceWait, r.now, r.domain)) return "RESOURCE_WAIT_UNKNOWN";
      if (a.blockingReason && c.projectedSlots) return "RESOURCE_WAIT_UNKNOWN";
      if (!c.projectedSlots && (a.reason === "RESOURCE_CAPACITY" || a.resourceWait.value !== 0)) return "RESOURCE_CAPACITY";
      if (a.reason === "LOCAL_QUEUE_PENDING" && !r.queuedOccupancy) return "POLICY_WAIT_UNKNOWN";
      if (a.reason === "NO_CATEGORY_CREDIT" || !r.initialOccupancy && a.reason !== "AVAILABLE") return "NO_CATEGORY_CREDIT";
      if ((!r.queuedOccupancy || c.queueObserved === false) && (!sampleUsableV2(a.policyWait, r.now, r.domain) || a.policyWait.value !== c.queueMs)) return "POLICY_WAIT_UNKNOWN";
    }
    if (!Number.isFinite(node.memoryBytes) || node.memoryBytes < 0 || !Number.isFinite(c.availableSlots) || !Number.isFinite(c.availableMemoryBytes) || c.availableSlots < 1 || c.availableMemoryBytes < requiredMemory) return "CAPACITY_UNAVAILABLE";
    if (!c.targetId || !c.resourcePoolIds.length || new Set(c.resourcePoolIds).size !== c.resourcePoolIds.length) return "RESOURCE_POOLS_INVALID";
    for (const poolId of c.resourcePoolIds) {
      const pools = r.deviceResources.filter((p) => p.deviceId === c.deviceId && p.resourcePoolId === poolId);
      if (pools.length !== 1) return "SHARED_CAPACITY_UNKNOWN";
      const pool = pools[0];
      if (!Number.isFinite(pool.observedAt) || pool.observedAt > r.now || !Number.isFinite(pool.ttlMs) || pool.ttlMs <= 0 || r.now - pool.observedAt > pool.ttlMs) return "SHARED_CAPACITY_EXPIRED";
      if (c.resourceDemand) {
        const amount = c.resourceDemand.find((r2) => r2.resourcePoolId === poolId)?.amount;
        if (amount === void 0 || !Number.isSafeInteger(amount) || amount < 0 || pool.available === null || pool.available === void 0 || !Number.isFinite(pool.available) || pool.available < amount) return "SHARED_CAPACITY_UNAVAILABLE";
      } else if (pool.availableMemoryBytes === null || pool.availableSlots === null || !Number.isFinite(pool.availableMemoryBytes) || !Number.isFinite(pool.availableSlots) || pool.availableMemoryBytes < requiredMemory || pool.availableSlots < 1) return "SHARED_CAPACITY_UNAVAILABLE";
    }
    if (node.qualityRequirements?.length) {
      for (const required of node.qualityRequirements) {
        if (!required.metric || !required.evaluationId || !["higher", "lower"].includes(required.direction) || !Number.isFinite(required.value)) return "QUALITY_REQUIREMENT_INVALID";
        const evidence = c.qualityEvidence?.find((e) => e.metric === required.metric && e.evaluationId === required.evaluationId && e.direction === required.direction);
        if (!evidence || !Number.isFinite(evidence.value)) return "QUALITY_EVIDENCE_MISSING";
        if (required.direction === "higher" ? evidence.value < required.value : evidence.value > required.value) return "QUALITY_REQUIREMENT_UNMET";
      }
    } else if (!Number.isFinite(node.minimumQuality) || c.quality === null || !Number.isFinite(c.quality) || c.quality < node.minimumQuality) return "QUALITY_UNKNOWN_OR_LOW";
    if ([c.computeMs, c.queueMs, c.coldMs, c.uncertaintyMs, c.publishMs].some((n) => n === null || !Number.isFinite(n) || n < 0)) return "COST_UNKNOWN";
    return null;
  }
  /** Price a fixed producer's publication; it never selects or dispatches another executor. */
  publication(artifact, to, request) {
    return this.transfer(artifact, to, request);
  }
  transfer(artifact, to, r, holderInstanceId) {
    return this.transferRoute(artifact, to, r, holderInstanceId)?.cost ?? null;
  }
  transferRoute(artifact, to, r, holderInstanceId) {
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) return null;
    const choices = [];
    const fresh = (l) => l.source === r.domain && l.observedAt <= r.now && r.now - l.observedAt <= l.ttlMs && Number.isFinite(l.ttlMs) && l.ttlMs > 0 && Number.isFinite(l.bytesPerSecond) && l.bytesPerSecond > 0 && Number.isFinite(l.fixedMs) && l.fixedMs >= 0;
    for (const source of artifact.replicas) {
      if (source.readMs === null || !Number.isFinite(source.readMs) || source.readMs < 0) continue;
      const origin = { sourceHolderId: source.holderInstanceId, sourceEndpointId: source.endpointId, sourceEndpointEpoch: source.endpointEpoch };
      if (source.deviceId === to && (!source.holderInstanceId || source.holderInstanceId === holderInstanceId)) {
        choices.push({ cost: source.readMs, ...origin });
        continue;
      }
      if (source.localOnly || !r.networkAllowed || r.privacy === "LOCAL_ONLY") continue;
      if (source.holderInstanceId && r.inputRelayId) {
        const upload = this.transfer({ id: artifact.id, bytes: artifact.bytes, replicas: [{ deviceId: source.deviceId, readMs: source.readMs }] }, r.inputRelayId, { ...r, inputRelayId: void 0 });
        const download = this.transfer({ id: artifact.id, bytes: artifact.bytes, replicas: [{ deviceId: r.inputRelayId, readMs: 0 }] }, to, { ...r, inputRelayId: void 0 });
        if (upload !== null && download !== null && (!r.relayCapacity || r.relayCapacity.deviceId === r.inputRelayId && r.relayCapacity.availableSlots >= 1 && (r.relayCapacity.availableBytes === void 0 || Number.isFinite(r.relayCapacity.availableBytes) && r.relayCapacity.availableBytes >= artifact.bytes) && r.relayCapacity.observedAt <= r.now && r.relayCapacity.observedAt + r.relayCapacity.ttlMs >= r.now)) choices.push({ cost: upload + download, ...origin, relayId: r.inputRelayId, uploadMs: upload, downloadMs: download });
        for (const link of r.links.filter((l) => l.endpointId && !r.excludedInputEndpoints?.includes(l.endpointId) && l.endpointEpoch && l.endpointOperation === (source.transferOperation ?? "WRITE") && l.from === source.deviceId && l.to === to && l.fromHolderInstanceId === source.holderInstanceId && l.toHolderInstanceId === holderInstanceId && fresh(l)))
          choices.push({ ...origin, cost: source.readMs + artifact.bytes / link.bytesPerSecond * 1e3 + (link.effective ? 0 : link.fixedMs), endpointId: link.endpointId, endpointEpoch: link.endpointEpoch, endpointOperation: link.endpointOperation });
      } else {
        for (const link of r.links.filter((l) => !l.endpointId && l.from === source.deviceId && l.to === to && fresh(l)))
          choices.push({ ...origin, cost: source.readMs + artifact.bytes / link.bytesPerSecond * 1e3 + (link.effective ? 0 : link.fixedMs) });
      }
    }
    choices.sort((a, b) => a.cost - b.cost);
    return choices[0] ?? null;
  }
  demands(c, node, r) {
    const result = [{ key: "target:" + c.targetId, amount: 1, capacity: c.availableSlots }];
    for (const poolId of c.resourcePoolIds) {
      const pool = r.deviceResources.find((p) => p.deviceId === c.deviceId && p.resourcePoolId === poolId);
      const key = poolOccupancyKey(c.deviceId, poolId);
      if (c.resourceDemand) result.push({ key, amount: c.resourceDemand.find((d) => d.resourcePoolId === poolId).amount, capacity: pool.available });
      else result.push({ key: key + ":slots", amount: 1, capacity: pool.availableSlots }, { key: key + ":memory", amount: c.requiredMemoryBytes ?? node.memoryBytes, capacity: pool.availableMemoryBytes });
    }
    if (c.holderCapacity) for (const d of c.resourceDemand ?? []) result.push({ key: poolOccupancyKey(c.deviceId, d.resourcePoolId, c.holderInstanceId), amount: d.amount, capacity: c.holderCapacity.find((p) => p.resourcePoolId === d.resourcePoolId).amount });
    return result;
  }
  extend(state, node, c, r, rejection) {
    let inputSourceHolderId, inputSourceEndpointId, inputSourceEndpointEpoch;
    let inputRelayId, inputUploadMs, inputDownloadMs;
    let inputEndpointId, inputEndpointEpoch, inputEndpointOperation;
    let transfer = 0, ready = Math.max(0, ...node.dependencies.map((id2) => state.completed.get(id2) ?? 0));
    const artifacts = new Map(state.artifacts);
    for (const id2 of new Set(node.inputs)) {
      const artifact = state.artifacts.get(id2);
      if (!artifact) return null;
      const route = this.transferRoute(artifact, c.deviceId, r, c.holderInstanceId);
      if (route === null) return null;
      if (node.inputs.length === 1) {
        inputSourceHolderId = route.sourceHolderId;
        inputSourceEndpointId = route.sourceEndpointId;
        inputSourceEndpointEpoch = route.sourceEndpointEpoch;
        inputRelayId = route.relayId;
        inputUploadMs = route.uploadMs;
        inputDownloadMs = route.downloadMs;
        inputEndpointId = route.endpointId;
        inputEndpointEpoch = route.endpointEpoch;
        inputEndpointOperation = route.endpointOperation;
      }
      transfer += route.cost;
      ready = Math.max(ready, state.ready.get(id2) ?? 0);
    }
    const output = { id: node.output.id, bytes: node.output.bytes, replicas: [{ deviceId: c.deviceId, readMs: 0 }] };
    const localResult = r.localResultHolderId !== void 0 && c.holderInstanceId === r.localResultHolderId && c.appInstanceId !== void 0 && c.appInstanceId === r.appInstanceId;
    const retained = !!(node.output.retainAtExecutor && c.dataEndpoint && c.holderInstanceId);
    if (retained) output.replicas[0] = { deviceId: c.deviceId, holderInstanceId: c.holderInstanceId, readMs: 0, transferOperation: "WRITE", endpointId: c.dataEndpoint.id, endpointEpoch: c.dataEndpoint.epoch };
    if (localResult) output.replicas[0].holderInstanceId = c.holderInstanceId;
    const publication = r.materializeOutputsAt && !localResult && !retained ? this.transfer(output, r.materializeOutputsAt, r) : 0;
    if (publication === null) return null;
    const execution = c.computeMs + c.queueMs + c.coldMs + c.publishMs + publication, duration = execution + c.uncertaintyMs;
    const relayDemands = inputRelayId && r.relayCapacity ? [{ key: "relay:" + inputRelayId, amount: 1, capacity: r.relayCapacity.availableSlots }] : [];
    const transferStart = earliestFeasibleV2(state.occupancy, relayDemands, ready, transfer);
    const demands = this.demands(c, node, r), arrival = transferStart + transfer;
    const queued = c.availability ? c.queueMs : 0;
    const resourceStart = earliestFeasibleV2(state.occupancy, demands, arrival + queued, duration - queued);
    const start = r.queuedOccupancy ? earliestFeasibleV2([...state.occupancy, ...r.queuedOccupancy], demands, arrival + queued, duration - queued) : resourceStart;
    if (!Number.isFinite(start)) {
      if (rejection) rejection.code = Number.isFinite(resourceStart) ? "POLICY_WAIT_UNKNOWN" : "RESOURCE_WAIT_UNKNOWN";
      return null;
    }
    const end = start + duration - queued, policyWait = start - resourceStart + queued;
    const cost = Math.max(state.cost, end);
    if (cost > r.remainingBudgetMs) {
      const sample = c.availability?.resourceWait, release = sample?.value ? sample.sampledAt + sample.value - r.now : 0;
      if (rejection && release > 0 && start > arrival && Math.max(state.cost, end - (start - arrival)) <= r.remainingBudgetMs) rejection.retryAfterMs = release;
      return null;
    }
    artifacts.set(node.output.id, r.materializeOutputsAt && !localResult && !retained ? { ...output, replicas: [{ deviceId: r.materializeOutputsAt, readMs: 0 }] } : output);
    const completed = new Map(state.completed);
    completed.set(node.id, end);
    const availability2 = new Map(state.ready);
    availability2.set(node.output.id, end);
    return {
      cost,
      artifacts,
      ready: availability2,
      completed,
      occupancy: [...state.occupancy, ...relayDemands.map((d) => ({ key: d.key, start: transferStart, end: transferStart + transfer, amount: d.amount })), ...demands.map((d) => ({ key: d.key, start, end, amount: d.amount }))],
      assignments: [...state.assignments, { ...inputSourceHolderId ? { inputSourceHolderId, inputSourceEndpointId, inputSourceEndpointEpoch } : {}, ...inputRelayId ? { inputRelayId, inputUploadMs, inputDownloadMs } : {}, ...retained ? { outputEndpointId: c.dataEndpoint.id, outputEndpointEpoch: c.dataEndpoint.epoch } : {}, ...inputEndpointId ? { inputEndpointId, inputEndpointEpoch, inputEndpointOperation } : {}, ...c.availability ? { policyQueueMs: policyWait, dagResourceWaitMs: resourceStart - arrival - queued } : {}, targetId: c.targetId, nodeId: node.id, deviceId: c.deviceId, executorId: c.executorId, ...c.costSource ? { costSource: c.costSource, costConfidence: c.costConfidence } : {}, phaseCosts: { EXECUTE: c.computeMs + c.coldMs, QUEUE: r.initialOccupancy ? start - arrival : c.queueMs, PUBLISH: c.publishMs + publication }, inputTransferMs: transfer, executionMs: execution + policyWait - queued, uncertaintyMs: c.uncertaintyMs, startMs: start, finishMs: end }]
    };
  }
  finish(state, nodes, r) {
    if (!state || !r.finalDestination || !nodes.length) return state;
    let cost = state.cost;
    for (const node of nodes.filter((n) => !nodes.some((other) => other.dependencies.includes(n.id)))) {
      const output = state.artifacts.get(node.output.id);
      if (r.localResultHolderId && output.replicas.some((replica) => replica.holderInstanceId === r.localResultHolderId)) continue;
      const transfer = this.transfer(output, r.finalDestination, r);
      if (transfer === null) return null;
      cost = Math.max(cost, (state.completed.get(node.id) ?? 0) + transfer);
    }
    return cost > r.remainingBudgetMs ? null : { ...state, cost };
  }
};

// packages/scheduler-core/src/cost.ts
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).filter(([, v]) => v !== void 0).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}

// packages/scheduler-core/src/capability-cost-model.ts
function costConfiguration(parameters, model) {
  if (!model) return { model: "size-only-v1" };
  if (!model.version || !Array.isArray(model.parameters) || model.parameters.length > 16 || new Set(model.parameters.map((p) => p.name)).size !== model.parameters.length) throw new Error("COST_MODEL_INVALID");
  const input = parameters ?? {}, values = {};
  for (const rule of model.parameters) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(rule.name)) throw new Error("COST_MODEL_INVALID");
    const value = input[rule.name];
    if (rule.bucketWidth !== void 0) {
      if (!Number.isFinite(rule.bucketWidth) || rule.bucketWidth <= 0) throw new Error("COST_MODEL_INVALID");
      values[rule.name] = typeof value === "number" && Number.isFinite(value) ? Math.floor(value / rule.bucketWidth) : null;
    } else {
      if (value !== void 0 && value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new Error("COST_PARAMETER_INVALID");
      if (typeof value === "string" && value.length > 128) throw new Error("COST_PARAMETER_INVALID");
      values[rule.name] = value ?? null;
    }
  }
  return { model: model.version, values, ...model.scale ? { scale: model.scale } : {} };
}
function workKeyV2(contract, parameters, inputBytes) {
  if (!Number.isSafeInteger(inputBytes) || inputBytes < 0) throw new Error("INPUT_BYTES_INVALID");
  if (contract.workModel !== void 0 && !validWorkModelV2(contract.workModel)) throw new Error("COST_MODEL_INVALID");
  const config = costConfiguration(contract.workModel ? JSON.parse(parameters) : null, contract.workModel);
  return canonical([contract.contractId, contract.version, config, contract.workModel?.inputBytes === "IGNORE" ? null : Math.floor(Math.log2(Math.max(1, inputBytes)))]);
}
function scaledWorkKey(key) {
  try {
    const model = JSON.parse(key ?? "null")?.[2], scale = model?.scale;
    return !!scale && typeof scale.parameter === "string" && Number.isFinite(scale.reference) && scale.reference > 0 && Number.isFinite(model.values?.[scale.parameter]) && model.values[scale.parameter] > 0;
  } catch {
    return false;
  }
}

// packages/scheduler-core/src/planning-api.ts
function costEstimatePolicy(settings) {
  const policy = { sampleTtlMs: 6e5, minSamples: 3, windowSamples: 32, ...settings };
  if (![policy.sampleTtlMs, policy.minSamples, policy.windowSamples].every((v) => Number.isSafeInteger(v) && v > 0) || policy.minSamples > policy.windowSamples || policy.windowSamples > 32) throw Error("COST_POLICY_INVALID");
  return policy;
}
function resolveCost(c, node, policy, minSamples, now, domain) {
  if (!c.costEvidence) return c;
  const e = c.costEvidence;
  const usable = (s) => sampleUsableV2(s, now, domain) ? s.value : null;
  const measured = c.computeSamples?.find((s) => s.count >= (scaledWorkKey(node.workKey) ? 1 : minSamples) && s.workKey === node.workKey && s.configId === c.configId && s.startup === c.startup && s.observedAt <= now && now - s.observedAt <= s.ttlMs);
  let scale = 1;
  try {
    const key = JSON.parse(node.workKey ?? "null"), model = key?.[2];
    if (model?.scale) {
      const units = model.values?.[model.scale.parameter];
      if (Number.isFinite(units) && units > 0 && model.scale.reference > 0) scale = units / model.scale.reference;
    }
  } catch {
  }
  const prior = usable(e.compute), compute = measured?.p50Ms ?? (prior === null ? null : prior * scale);
  return {
    ...c,
    computeMs: compute,
    coldMs: measured?.executionTotal ? 0 : measured?.coldP50Ms ?? usable(e.cold),
    publishMs: usable(e.publish),
    queueMs: c.availability ? c.queueObserved === false ? usable(c.availability.policyWait) : 0 : c.queueMs,
    uncertaintyMs: measured ? Math.max(measured.p90Ms - measured.p50Ms, measured.count < 3 ? measured.p50Ms : 0) : compute === null ? null : Math.round(compute * (policy.priorUncertaintyRatio ?? 0.5)),
    costSource: measured ? "MEASURED" : compute === null ? "UNKNOWN" : "PRIOR",
    costConfidence: measured ? measured.count < 8 ? "LOW" : "NORMAL" : void 0
  };
}
function seedReservations(snapshot, priority, now) {
  if (!snapshot.inFlight && !snapshot.queued) return {};
  const initialOccupancy = [], queuedOccupancy = [];
  function demands(item) {
    const candidate = snapshot.candidates.find((c) => c.targetId === item.targetId && c.deviceId === item.deviceId && c.holderInstanceId === item.holderInstanceId);
    const result = [{ key: "target:" + item.targetId, amount: 1, capacity: candidate?.projectedSlots ?? candidate?.availableSlots ?? 1 }];
    for (const resource of item.resources) {
      const pool = snapshot.resources.find((p) => p.deviceId === item.deviceId && p.resourcePoolId === resource.resourcePoolId);
      const share = candidate?.holderCapacity?.find((p) => p.resourcePoolId === resource.resourcePoolId);
      result.push(
        { key: poolOccupancyKey(item.deviceId, resource.resourcePoolId), amount: resource.amount, capacity: pool?.available ?? 0 },
        { key: poolOccupancyKey(item.deviceId, resource.resourcePoolId, item.holderInstanceId), amount: resource.amount, capacity: share?.amount ?? resource.amount }
      );
    }
    return result;
  }
  for (const flight of snapshot.inFlight ?? []) {
    const sample = flight.releaseAt;
    const end = !flight.overdue && sampleUsableV2(sample, now, snapshot.domain) && sample.value > now ? sample.value - now : Infinity;
    for (const demand of demands(flight)) initialOccupancy.push({ key: demand.key, amount: demand.amount, start: 0, end });
  }
  const ranks = ["ORIGIN_INTERACTIVE", "REMOTE_INTERACTIVE", "REMOTE_BATCH"], rank = ranks.indexOf(priority ?? "REMOTE_INTERACTIVE");
  const queue = (snapshot.queued ?? []).filter((item) => ranks.indexOf(item.priority) <= rank).sort((a, b) => ranks.indexOf(a.priority) - ranks.indexOf(b.priority) || b.elapsedMs - a.elapsedMs || a.attemptId.localeCompare(b.attemptId));
  for (const item of queue) {
    const demand = demands(item), known = sampleUsableV2(item.holdEstimate, now, snapshot.domain);
    const duration = known ? item.holdEstimate.value : Infinity;
    const earliest = known ? earliestFeasibleV2([...initialOccupancy, ...queuedOccupancy], demand, 0, duration) : 0;
    const start = Number.isFinite(earliest) ? earliest : 0, end = Number.isFinite(earliest) ? earliest + duration : Infinity;
    for (const resource of demand) queuedOccupancy.push({ key: resource.key, amount: resource.amount, start, end });
  }
  return { initialOccupancy, queuedOccupancy };
}
function plan(snapshot, request, policy, clock) {
  if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 1 || snapshot.policyVersion !== policy.version || policy.revoked || !Number.isFinite(clock.now) || !Number.isFinite(snapshot.capturedAt) || snapshot.capturedAt > clock.now || snapshot.devices.length > 1024 || snapshot.candidates.length > 4096 || snapshot.resources.length > 4096 || snapshot.links.length > 4096) throw new Error("SNAPSHOT_OR_POLICY_INVALID");
  if (policy.priorUncertaintyRatio !== void 0 && (!Number.isFinite(policy.priorUncertaintyRatio) || policy.priorUncertaintyRatio <= 0 || policy.priorUncertaintyRatio > 2)) throw Error("SNAPSHOT_OR_POLICY_INVALID");
  const deviceIds = /* @__PURE__ */ new Set();
  const validDevices = new Set(snapshot.devices.filter((d) => {
    const key = d.deviceId + ":" + (d.holderInstanceId ?? "");
    if (deviceIds.has(key)) throw new Error("DEVICE_IDENTITY_AMBIGUOUS");
    deviceIds.add(key);
    return !!d.deviceId && !!d.deviceInstanceId && Number.isSafeInteger(d.ledgerEpoch) && d.ledgerEpoch > 0 && Number.isFinite(d.sampledAt) && d.sampledAt <= clock.now && Number.isFinite(d.ttlMs) && d.ttlMs > 0 && clock.now - d.sampledAt <= d.ttlMs;
  }).map((d) => d.deviceId + ":" + (d.holderInstanceId ?? "")));
  const candidates = snapshot.candidates.filter((c) => (c.appInstanceId === void 0 || c.appInstanceId === request.appInstanceId) && validDevices.has(c.deviceId + ":" + (c.holderInstanceId ?? "")) && policy.allowedTargetIds.includes(c.targetId)).map((c) => {
    const priority = request.priority ?? "REMOTE_INTERACTIVE";
    const capacity = c.categoryCapacity?.find((v) => v.priority === priority);
    if (capacity) return { ...c, availability: capacity.availability, availableSlots: capacity.slots || (capacity.availability.reason === "RESOURCE_CAPACITY" || capacity.availability.reason === "LOCAL_QUEUE_PENDING" ? c.projectedSlots ?? 0 : 0) };
    return request.priority === "REMOTE_BATCH" ? { ...c, availableSlots: 0 } : c;
  });
  const estimatePolicy = costEstimatePolicy(policy.costEstimate);
  const reservations = seedReservations(snapshot, request.priority, clock.now);
  const effective = {
    ...request,
    ...reservations,
    snapshotVersion: snapshot.version,
    now: clock.now,
    domain: snapshot.domain,
    deviceResources: snapshot.resources,
    links: snapshot.links,
    nodes: request.nodes.map((node) => ({ ...node, candidates: candidates.filter((c) => c.capability === node.capability && (!node.allowedTargetIds || node.allowedTargetIds.includes(c.targetId))).map((c) => resolveCost(c, node, policy, estimatePolicy.minSamples, clock.now, snapshot.domain)) }))
  };
  const decision = new WorkflowPlacementPlanner(policy.limits, clock.monotonic).plan(effective);
  for (const target of snapshot.excludedTargets ?? []) {
    if (!policy.allowedTargetIds.includes(target.targetId) || target.appInstanceId !== void 0 && target.appInstanceId !== request.appInstanceId) continue;
    for (const node of effective.nodes) {
      if (node.capability === target.capability && !request.committedNodeIds.includes(node.id) && (!node.allowedTargetIds || node.allowedTargetIds.includes(target.targetId)))
        decision.rejections.push({ nodeId: node.id, targetId: target.targetId, deviceId: target.deviceId, executorId: target.executorId, code: target.code });
    }
  }
  return { groupId: snapshot.groupId, domain: snapshot.domain, snapshotVersion: snapshot.version, policyVersion: policy.version, decision };
}

// packages/scheduler-core/src/availability.ts
function availability(profile, e, priority, version, now) {
  let wait = 0, expires = Infinity, blocked = false, priorCapacity = false;
  let blockingReason;
  for (const demand of e.resources.filter((r) => r.amount > 0)) {
    const pool = profile.pools.find((p) => p.resourcePoolId === demand.resourcePoolId);
    if (!pool || ![pool.occupied, pool.admissionLimit].every((s) => sampleUsableV2(s, now, profile.domain))) {
      blocked = true;
      wait = null;
      break;
    }
    priorCapacity = priorCapacity || pool.occupied.source === "PRIOR" || pool.admissionLimit.source === "PRIOR";
    expires = Math.min(expires, pool.occupied.sampledAt + pool.occupied.ttlMs, pool.admissionLimit.sampledAt + pool.admissionLimit.ttlMs);
    const deficit = demand.amount + pool.occupied.value - pool.admissionLimit.value;
    if (deficit <= 0) continue;
    blocked = true;
    for (const fact of profile.inFlight ?? []) {
      if (!fact.resources.some((r) => r.resourcePoolId === demand.resourcePoolId && r.amount > 0)) continue;
      const contract = profile.executors.find((x) => x.target.targetId === fact.targetId)?.contract;
      if (contract?.interruptibility !== "NON_INTERRUPTIBLE") continue;
      if (contract.maxNonPreemptibleMs !== null && sampleUsableV2(fact.elapsed, now, profile.domain) && fact.elapsed.value > contract.maxNonPreemptibleMs) {
        blockingReason = "RELEASE_OVERDUE";
        break;
      }
      blockingReason = "NON_INTERRUPTIBLE_RUNNING";
    }
    if (blockingReason === "RELEASE_OVERDUE") {
      wait = null;
      break;
    }
    const releases = (profile.inFlight ?? []).map((f) => ({ amount: f.resources.find((r) => r.resourcePoolId === demand.resourcePoolId)?.amount ?? 0, s: f.remaining })).filter((r) => r.amount > 0);
    if (releases.reduce((sum, r) => sum + r.amount, 0) !== pool.occupied.value) {
      wait = null;
      break;
    }
    const known = releases.filter((r) => sampleUsableV2(r.s, now, profile.domain) && r.s.value > now - r.s.sampledAt).sort((a, b) => a.s.sampledAt + a.s.value - (b.s.sampledAt + b.s.value));
    let freed = 0;
    for (const r of known) {
      freed += r.amount;
      expires = Math.min(expires, r.s.sampledAt + r.s.ttlMs, r.s.sampledAt + r.s.value);
      if (freed >= deficit) {
        wait = Math.max(wait, r.s.sampledAt + r.s.value - now);
        break;
      }
    }
    if (freed < deficit) {
      wait = null;
      break;
    }
  }
  const queued = profile.queued?.some((q) => q.resources.some((r) => r.amount > 0 && e.resources.some((d) => d.amount > 0 && d.resourcePoolId === r.resourcePoolId)));
  const credit = profile.credits.some((c) => c.priority === priority && c.slots > 0);
  return {
    targetId: e.target.targetId,
    snapshotVersion: version,
    poolIds: [...e.target.resourcePoolIds],
    ...blockingReason ? { blockingReason } : {},
    reason: blocked ? "RESOURCE_CAPACITY" : queued ? "LOCAL_QUEUE_PENDING" : credit ? "AVAILABLE" : "NO_CATEGORY_CREDIT",
    resourceWait: {
      value: wait,
      source: wait === null ? "UNKNOWN" : blocked || priorCapacity ? "PRIOR" : profile.domain === "REAL" ? "MEASURED" : "SIMULATED",
      unit: "ms",
      sampledAt: now,
      ttlMs: Math.max(1, Math.min(15e3, expires - now))
    },
    policyWait: credit && !queued ? e.queue : { value: null, source: "UNKNOWN", unit: "ms", sampledAt: now, ttlMs: 1 }
  };
}

// packages/scheduler-core/src/native-coordinator-planning.ts
function nativePlanJson(profilesJson, evidenceJson, requestJson, now, monotonic) {
  const profiles = JSON.parse(profilesJson), evidence = JSON.parse(evidenceJson), input = JSON.parse(requestJson);
  const version = now, priority = input.priority ?? "REMOTE_INTERACTIVE", candidates = [], resources = [], links = [];
  const usable = (s) => sampleUsableV2(s, now, "REAL");
  for (const p of profiles) {
    if (!usable(p.ownerActivity) || p.ownerActivity.value !== "IDLE" || !usable(p.foreground) || p.foreground.value !== "FOREGROUND" || !usable(p.powerSave) || p.powerSave.value === "ON" || p.energyGate && p.energyGate !== "NONE") continue;
    for (const pool of p.pools) {
      if (!usable(pool.admissionLimit) || !usable(pool.occupied) || pool.draining) continue;
      const free = Math.max(0, pool.admissionLimit.value - pool.occupied.value), existing = resources.find((r) => r.deviceId === p.deviceId && r.resourcePoolId === pool.resourcePoolId);
      if (existing) existing.available += free;
      else resources.push({ deviceId: p.deviceId, resourcePoolId: pool.resourcePoolId, available: free, availableMemoryBytes: null, availableSlots: null, observedAt: now, ttlMs: 1e3 });
    }
    for (const e of p.executors) {
      const q = evidence.find((v) => v.admission.targetId === e.target.targetId && v.admission.holderInstanceId === p.holderInstanceId);
      if (!q || q.admission.state !== "ACTIVE" || !usable(q.admission.quality)) continue;
      const shares = e.resources.map((r) => {
        const pool = p.pools.find((v) => v.resourcePoolId === r.resourcePoolId);
        return { resourcePoolId: r.resourcePoolId, amount: pool && usable(pool.admissionLimit) && usable(pool.occupied) && !pool.draining ? Math.max(0, pool.admissionLimit.value - pool.occupied.value) : 0 };
      });
      if (e.resources.some((r) => shares.find((v) => v.resourcePoolId === r.resourcePoolId).amount < r.amount)) continue;
      const ram = e.resources.filter((r) => p.pools.some((v) => v.resourcePoolId === r.resourcePoolId && v.kind === "RAM_BYTES")).reduce((sum, r) => sum + r.amount, 0);
      const compute = usable(e.compute) ? e.compute.value : q.computeMs;
      const idle = p.inFlight?.length === 0 && p.queued?.length === 0;
      const projected = idle && !usable(e.queue) ? { ...e, queue: { value: 0, source: "MEASURED", sampledAt: now, ttlMs: 1e3, unit: "ms" } } : e;
      candidates.push({
        holderInstanceId: p.holderInstanceId,
        targetId: e.target.targetId,
        deviceId: p.deviceId,
        executorId: e.target.executorId,
        capability: e.contract.capability,
        resourcePoolIds: e.target.resourcePoolIds,
        resourceDemand: e.resources,
        holderCapacity: shares,
        modelManifest: e.model,
        requiredMemoryBytes: ram,
        trusted: true,
        source: "REAL",
        observedAt: now,
        ttlMs: 1e3,
        availableSlots: p.credits.find((v) => v.priority === priority)?.slots ?? 0,
        availableMemoryBytes: shares.filter((r) => p.pools.some((v) => v.resourcePoolId === r.resourcePoolId && v.kind === "RAM_BYTES")).reduce((sum, r) => sum + r.amount, 0),
        quality: q.admission.quality.value,
        computeMs: compute,
        queueMs: usable(projected.queue) ? projected.queue.value : null,
        coldMs: usable(e.cold) ? e.cold.value : null,
        publishMs: usable(e.publish) ? e.publish.value : null,
        uncertaintyMs: compute === null ? null : compute * 0.5,
        availability: availability(p, projected, priority, version, now),
        ...e.contract.serviceId ? { serviceId: e.contract.serviceId } : {}
      });
    }
    for (const l of p.links) {
      if (l.via !== null || !usable(l.fixedMs) || !usable(l.bytesPerSecond) || l.bytesPerSecond.value <= 0) continue;
      if (!links.some((v) => v.from === l.from && v.to === l.to)) links.push({ from: l.from, to: l.to, bytesPerSecond: l.bytesPerSecond.value, fixedMs: l.fixedMs.value, effective: false, source: "REAL", observedAt: now, ttlMs: 1e3 });
    }
  }
  const contract = input.contract, node = input.node;
  const request = {
    priority,
    nodes: [{ id: node.id, workKey: workKeyV2(contract, node.parameters, node.input.bytes), capability: node.capability, dependencies: [], inputs: [input.artifactId], output: { id: "out-" + input.id, bytes: Math.min(8388608, node.input.bytes * 64 + 4096) }, baselineTargetId: node.targetId ?? "", ...node.targetId ? { allowedTargetIds: [node.targetId] } : {}, ...node.executionScope === "ORIGIN_DEVICE" || node.privacy === "LOCAL_ONLY" ? { dataScope: "LOCAL_ONLY" } : {}, memoryBytes: 0, minimumQuality: 1, candidates: [] }],
    artifacts: [{ id: input.artifactId, bytes: node.input.bytes, replicas: [{ deviceId: input.coordinatorId, readMs: 0 }] }],
    links: [],
    deviceResources: [],
    remainingBudgetMs: input.budgetMs,
    networkAllowed: true,
    privacy: node.privacy === "LOCAL_ONLY" ? "LOCAL_ONLY" : "AUTHORIZED_REMOTE",
    localDeviceId: input.originDeviceId,
    originHolderId: input.originHolderId,
    appInstanceId: input.appInstanceId,
    domain: "REAL",
    now,
    committedNodeIds: [],
    committedArtifacts: [],
    materializeOutputsAt: input.coordinatorId,
    finalDestination: input.coordinatorId
  };
  const snapshot = { version, policyVersion: "native-main-v1", groupId: input.groupId, domain: "REAL", capturedAt: now, devices: profiles.map((p) => ({ deviceId: p.deviceId, holderInstanceId: p.holderInstanceId, deviceInstanceId: p.deviceInstanceId, ledgerEpoch: p.ledgerEpoch, sampledAt: p.ownerActivity.sampledAt, ttlMs: p.ownerActivity.ttlMs })), resources, candidates, links };
  const policy = { version: snapshot.policyVersion, revoked: false, allowedTargetIds: candidates.map((c) => c.targetId), limits: { maxCandidates: 64, lookahead: 8, beamWidth: 16, planningBudgetMs: 50, switchCostMs: 0, hysteresisMs: 0 } };
  return JSON.stringify(plan(snapshot, request, policy, { now, monotonic }));
}

// <stdin>
function planJson(snapshot, request, policy, now, monotonic) {
  return JSON.stringify(plan(JSON.parse(snapshot), JSON.parse(request), JSON.parse(policy), { now, monotonic }));
}
function availabilityJson(profile, executor, priority, version, now) {
  return JSON.stringify(availability(JSON.parse(profile), JSON.parse(executor), priority, version, now));
}
export {
  availabilityJson,
  nativePlanJson,
  planJson
};
