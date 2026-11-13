// packages/scheduler-core/src/photo-size.ts
function photoOutputBound(capability, parameters, fallback) {
  if (!capability.startsWith("photo.")) return fallback;
  try {
    const p = JSON.parse(parameters);
    let w = p.width, h = p.height;
    if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 1 || h < 1 || w * h > 16777216) return fallback;
    if (capability === "photo.prepare.v1") {
      w += 32;
      h += 32;
    }
    if (["photo.enhance.v1", "photo.assemble.v1"].includes(capability)) {
      w *= 4;
      h *= 4;
    }
    const raw = w * h * 4 + h, png = raw + Math.ceil(raw / 16384) * 6 + 4096;
    const bound = capability === "photo.assemble.v1" ? png : Math.ceil(png / 3) * 4 + 2048 + (capability === "photo.deliver.v1" ? Math.min(w, 480) * Math.min(h, 360) * 4 + 4096 : 0);
    return Math.min(8388608, bound);
  } catch {
    return fallback;
  }
}

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
  const version = now, priority = input.priority ?? "REMOTE_INTERACTIVE", candidates = [], resources = [], links = [], inFlight = [], queued = [];
  const backlog = (input.backlog ?? []).map((s) => JSON.parse(s));
  const usable = (s) => sampleUsableV2(s, now, "REAL");
  for (const p of profiles) {
    if (input.originLocal && p.holderInstanceId !== input.originHolderId) continue;
    if (!usable(p.ownerActivity) || p.ownerActivity.value !== "IDLE" || !usable(p.foreground) || p.foreground.value !== "FOREGROUND" || !usable(p.powerSave) || p.powerSave.value === "ON" || p.energyGate && p.energyGate !== "NONE") continue;
    const jobs = backlog.filter((j) => j.owner.groupId === input.groupId && j.holder === p.holderInstanceId && j.deadlineAt > now);
    const selected = (id2, target) => {
      const j = jobs.find((j2) => j2.offer?.task.attemptId === id2 && j2.offer.target.targetId === target);
      return j ? JSON.parse(j.decision).decision.suggestion?.[0] : null;
    };
    const pending = jobs.filter((j) => !p.inFlight?.some((f) => f.attemptId === j.offer.task.attemptId) && !p.queued?.some((q) => q.attemptId === j.offer.task.attemptId));
    for (const j of pending) {
      if (p.queued === void 0) continue;
      for (const r of j.offer.resources) {
        const pool = p.pools.find((v) => v.resourcePoolId === r.resourcePoolId);
        if (pool && usable(pool.occupied)) pool.occupied.value = Math.max(0, pool.occupied.value - r.amount);
      }
      if (p.queued) p.queued.push({ attemptId: j.offer.task.attemptId, targetId: j.offer.target.targetId, resources: j.offer.resources, priority: j.offer.task.priority, elapsed: { value: 0, source: "PRIOR", sampledAt: now, ttlMs: 1e3, unit: "ms" } });
    }
    for (const f of p.inFlight ?? []) {
      if (usable(f.remaining) && f.remaining.sampledAt + f.remaining.value > now) continue;
      const e = p.executors.find((e2) => e2.target.targetId === f.targetId), s = selected(f.attemptId, f.targetId), estimate = s ? s.executionMs - (s.policyQueueMs ?? 0) + (s.uncertaintyMs ?? 0) : null;
      if (e?.contract.sideEffectPolicy === "PURE" && usable(f.elapsed) && Number.isFinite(estimate) && estimate > 0) {
        const left = Math.max(100, estimate - f.elapsed.value, Math.min(estimate, Math.max(100, f.elapsed.value * 0.25)));
        f.remaining = { value: left, source: "PRIOR", sampledAt: now, ttlMs: Math.min(1e3, f.elapsed.ttlMs), unit: "ms" };
      }
    }
    const projects = p.inFlight !== void 0 && p.pools.every((pool) => !pool.draining && usable(pool.occupied) && usable(pool.admissionLimit) && p.inFlight.reduce((sum, f) => sum + (f.resources.find((r) => r.resourcePoolId === pool.resourcePoolId)?.amount ?? 0), 0) === pool.occupied.value);
    if (projects) for (const f of p.inFlight) {
      const c = p.executors.find((e) => e.target.targetId === f.targetId)?.contract, overdue = c?.interruptibility === "NON_INTERRUPTIBLE" && c.maxNonPreemptibleMs !== null && usable(f.elapsed) && f.elapsed.value > c.maxNonPreemptibleMs;
      inFlight.push({ deviceId: p.deviceId, holderInstanceId: p.holderInstanceId, targetId: f.targetId, resources: f.resources, overdue, releaseAt: { ...f.remaining, value: f.remaining.value === null ? null : f.remaining.sampledAt + f.remaining.value } });
    }
    for (const q of p.queued ?? []) {
      const s = selected(q.attemptId, q.targetId), duration = s ? s.executionMs - (s.policyQueueMs ?? 0) : null, value = typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : null;
      queued.push({ deviceId: p.deviceId, holderInstanceId: p.holderInstanceId, targetId: q.targetId, resources: q.resources, priority: q.priority, attemptId: q.attemptId, elapsedMs: q.elapsed.value ?? 0, holdEstimate: { value, source: value === null ? "UNKNOWN" : "PRIOR", sampledAt: q.elapsed.sampledAt, ttlMs: q.elapsed.ttlMs, unit: "ms" } });
    }
    for (const pool of p.pools) {
      if (!usable(pool.admissionLimit) || !usable(pool.occupied) || pool.draining) continue;
      const free = Math.max(0, pool.admissionLimit.value - (projects ? 0 : pool.occupied.value)), existing = resources.find((r) => r.deviceId === p.deviceId && r.resourcePoolId === pool.resourcePoolId);
      if (existing) existing.available += free;
      else resources.push({ deviceId: p.deviceId, resourcePoolId: pool.resourcePoolId, available: free, availableMemoryBytes: null, availableSlots: null, observedAt: now, ttlMs: 1e3 });
    }
    for (const e of p.executors) {
      const q = evidence.find((v) => v.admission.targetId === e.target.targetId && v.admission.holderInstanceId === p.holderInstanceId);
      if (!q || q.admission.state !== "ACTIVE" || !usable(q.admission.quality)) continue;
      const shares = e.resources.map((r) => {
        const pool = p.pools.find((v) => v.resourcePoolId === r.resourcePoolId);
        return { resourcePoolId: r.resourcePoolId, amount: pool && usable(pool.admissionLimit) && usable(pool.occupied) && !pool.draining ? Math.max(0, pool.admissionLimit.value - (projects ? 0 : pool.occupied.value)) : 0 };
      });
      if (e.resources.some((r) => shares.find((v) => v.resourcePoolId === r.resourcePoolId).amount < r.amount)) continue;
      const ram = e.resources.filter((r) => p.pools.some((v) => v.resourcePoolId === r.resourcePoolId && v.kind === "RAM_BYTES")).reduce((sum, r) => sum + r.amount, 0);
      const compute = usable(e.compute) ? e.compute.value : q.computeMs;
      const idle = p.inFlight !== void 0 && p.queued?.length === 0;
      const projected = idle && !usable(e.queue) ? { ...e, queue: { value: 0, source: "MEASURED", sampledAt: now, ttlMs: 1e3, unit: "ms" } } : e;
      const forecast = availability(p, projected, priority, version, now), slots = Math.min(...e.resources.filter((r) => r.amount > 0).map((r) => Math.floor(shares.find((v) => v.resourcePoolId === r.resourcePoolId).amount / r.amount)));
      candidates.push({
        ...projects ? { projectedSlots: slots, categoryCapacity: [{ priority, slots: p.credits.find((v) => v.priority === priority)?.slots ?? 0, availability: forecast }] } : {},
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
        queueObserved: p.queued !== void 0,
        computeSamples: nativeComputeSamples(input.history ?? [], p, e, q, now),
        costEvidence: { compute: usable(e.compute) ? e.compute : { value: q.computeMs, source: q.computeMs === null ? "UNKNOWN" : "PRIOR", sampledAt: now, ttlMs: 1e3, unit: "ms" }, cold: e.cold, publish: e.publish },
        configId: e.configurations[0]?.id,
        startup: e.startup,
        quality: q.admission.quality.value,
        computeMs: compute,
        queueMs: usable(projected.queue) ? projected.queue.value : null,
        coldMs: usable(e.cold) ? e.cold.value : null,
        publishMs: usable(e.publish) ? e.publish.value : null,
        uncertaintyMs: compute === null ? null : compute * 0.5,
        availability: forecast,
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
    nodes: [{ id: node.id, workKey: workKeyV2(contract, node.parameters, node.input.bytes), capability: node.capability, dependencies: [], inputs: [input.artifactId], output: { id: "out-" + input.id, bytes: photoOutputBound(node.capability, node.parameters, Math.min(8388608, node.input.bytes * 64 + 4096)) }, baselineTargetId: node.targetId ?? "", ...node.targetId ? { allowedTargetIds: [node.targetId] } : {}, ...node.executionScope === "ORIGIN_DEVICE" || node.privacy === "LOCAL_ONLY" ? { dataScope: "LOCAL_ONLY" } : {}, memoryBytes: 0, minimumQuality: 1, candidates: [] }],
    artifacts: [{ id: input.artifactId, bytes: node.input.bytes, replicas: [input.originLocal ? { deviceId: input.originDeviceId, holderInstanceId: input.originHolderId, readMs: 0 } : { deviceId: input.coordinatorId, readMs: 0 }] }],
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
  const snapshot = { version, policyVersion: "native-photo-perf-v3", groupId: input.groupId, domain: "REAL", capturedAt: now, devices: profiles.map((p) => ({ deviceId: p.deviceId, holderInstanceId: p.holderInstanceId, deviceInstanceId: p.deviceInstanceId, ledgerEpoch: p.ledgerEpoch, sampledAt: p.ownerActivity.sampledAt, ttlMs: p.ownerActivity.ttlMs })), resources, candidates, links, inFlight, queued };
  const policy = { version: snapshot.policyVersion, revoked: false, allowedTargetIds: candidates.map((c) => c.targetId), limits: { maxCandidates: 64, lookahead: 8, beamWidth: 16, planningBudgetMs: 50, switchCostMs: 0, hysteresisMs: 0 } };
  return JSON.stringify(plan(snapshot, request, policy, { now, monotonic }));
}
function nativeComputeSamples(rows, profile, executor, qualification, now) {
  const groups = /* @__PURE__ */ new Map(), seen = /* @__PURE__ */ new Set();
  for (const row of rows) {
    const j = JSON.parse(row.job), s = JSON.parse(row.span), offer = j.offer;
    if (j.state !== "SUCCEEDED" || j.owner.groupId !== qualification.admission.groupId || j.holder !== profile.holderInstanceId || !j.executionIdentity || j.executionIdentity !== qualification.admission.identity || j.startup !== executor.startup || offer?.target.targetId !== executor.target.targetId || canonical(offer.target) !== canonical(executor.target) || offer.allowedConfigs.length !== 1 || offer.allowedConfigs[0].id !== executor.configurations[0]?.id || canonical(offer.task.contract) !== canonical(executor.contract)) continue;
    const at = j.settledAt ?? s.snapshotVersion;
    if (s.phase !== "EXECUTE" || s.measurementScope !== "LOCAL_INTERVAL" || s.authoritativeSide !== "SELF" || s.attemptId !== offer.task.attemptId || s.traceId !== j.traceId || s.targetId !== executor.target.targetId || s.snapshotVersion !== JSON.parse(j.decision).snapshotVersion || !(s.durationMs > 0) || !Number.isFinite(s.durationMs) || at > now || now - at > 6e5 || seen.has(s.attemptId)) continue;
    seen.add(s.attemptId);
    const key = workKeyV2(offer.task.contract, offer.task.parameters, j.input.bytes), group = groups.get(key) ?? [];
    group.push({ ms: s.durationMs, at });
    groups.set(key, group);
  }
  const quantile = (values, q) => {
    const weighted = values.map((s, i) => ({ ...s, w: Math.pow(0.65, values.length - 1 - i) })), threshold = weighted.reduce((n, s) => n + s.w, 0) * q;
    let total = 0;
    for (const s of weighted.sort((a, b) => a.ms - b.ms)) {
      total += s.w;
      if (total >= threshold) return s.ms;
    }
    return weighted[weighted.length - 1].ms;
  };
  return [...groups].map(([workKey, g]) => {
    const recent = g.sort((a, b) => a.at - b.at).slice(-8);
    return { workKey, configId: executor.configurations[0].id, startup: executor.startup, count: recent.length, p50Ms: quantile(recent, 0.5), p90Ms: quantile(recent, 0.9), coldP50Ms: 0, executionTotal: true, observedAt: recent[0].at, ttlMs: 6e5 };
  });
}

// packages/scheduler-core/src/native-photo-engine.ts
var NativePhotoEngine = class {
  constructor(port) {
    this.port = port;
    this.summaries = /* @__PURE__ */ new Map();
    this.active = /* @__PURE__ */ new Set();
    this.locks = /* @__PURE__ */ new Map();
  }
  async call(op, data = {}) {
    return JSON.parse(await this.port.call(op, JSON.stringify(data)));
  }
  async get(key) {
    return this.call("get", { key });
  }
  async save(key, value) {
    await this.call("put", { key, value });
  }
  async lock(key, work) {
    const previous = this.locks.get(key) ?? Promise.resolve(), next = previous.catch(() => {
    }).then(work);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
  owns(peer, g) {
    if (!g || g.peer.groupId !== peer.groupId || g.peer.holderInstanceId !== peer.holderInstanceId || g.peer.app?.appInstanceId !== peer.app?.appInstanceId) throw Error("JOB_SCOPE");
  }
  async sdk(peerJson, path, bodyJson) {
    const peer = JSON.parse(peerJson), body = bodyJson ? JSON.parse(bodyJson) : null;
    return JSON.stringify(await this.sdkValue(peer, path, body));
  }
  async sdkValue(peer, path, body) {
    if (path === "/v2/sdk/jobs") {
      const w = body?.workflow, o = body?.options;
      if (!peer.app || !w || w.version !== 3 || !Array.isArray(w.nodes) || w.nodes.length < 2 || w.nodes.length > 32 || !/^[A-Za-z0-9_.:-]{1,80}$/.test(o?.requestId) || !(o.budgetMs > 0 && o.budgetMs <= 3e5) || o.resultDestination !== "ORIGIN") throw Error("SDK_WORKFLOW_INVALID");
      const key2 = "graph:" + o.requestId;
      return this.lock(key2, async () => {
        let g2 = await this.get(key2);
        if (g2) {
          this.owns(peer, g2);
          if (JSON.stringify(g2.workflow) !== JSON.stringify(w)) throw Error("JOB_CONFLICT");
          return g2.plan;
        }
        const known = /* @__PURE__ */ new Set();
        for (const n of w.nodes) {
          if (!/^[A-Za-z0-9_-]{1,40}$/.test(n.id) || known.has(n.id) || !Array.isArray(n.dependsOn) || n.dependsOn.some((x) => !known.has(x)) || !peer.app.allowedContracts.includes(n.capability) || typeof n.parameters !== "string") throw Error("SDK_GRAPH_NODE_INVALID");
          JSON.parse(n.parameters);
          if (n.inputFrom && !n.dependsOn.includes(n.inputFrom) || n.inputFroms?.some((x) => !n.dependsOn.includes(x))) throw Error("SDK_GRAPH_EDGE_INVALID");
          known.add(n.id);
        }
        const roots = w.nodes.filter((n) => n.input);
        if (roots.length !== 1 || roots[0].dependsOn.length || w.nodes.some((n) => [!!n.input, !!n.inputFrom, !!n.inputFroms].filter(Boolean).length !== 1)) throw Error("SDK_GRAPH_ROOT_INVALID");
        const root = roots[0], input = await this.call("artifact", { peer, input: root.input, id: "in-" + o.requestId });
        const originLocal = o.inputLocation === "ORIGIN" && root.executionScope === "ORIGIN_DEVICE";
        const plan2 = { jobId: o.requestId, targetId: "", deviceId: peer.deviceId, reason: "NATIVE_DAG_PLANNING", inputDelivery: originLocal ? "LOCAL" : "RELAY", inputTicket: input.ticket };
        g2 = { peer, originLocal, workflow: w, options: o, input: input.descriptor, plan: plan2, state: "WAITING_INPUT", deadlineAt: this.port.now() + o.budgetMs, createdAt: this.port.now(), nodes: w.nodes.map((n) => ({ id: n.id, jobId: o.requestId + "." + n.id, state: "PENDING" })) };
        await this.save(key2, g2);
        return plan2;
      });
    }
    const match = /^\/v2\/sdk\/jobs\/([A-Za-z0-9_.:-]+)(?:\/(start|cancel|received))?$/.exec(path);
    if (!match) throw Error("SDK_ROUTE_INVALID");
    const key = "graph:" + match[1], action = match[2];
    if (action === "start") return this.lock(key, async () => {
      const g2 = await this.get(key);
      this.owns(peer, g2);
      if (g2.state === "WAITING_INPUT") {
        if (!g2.originLocal && !await this.call("available", { descriptor: g2.input })) throw Error("INPUT_NOT_UPLOADED");
        g2.state = "ACTIVE";
        await this.save(key, g2);
      }
      this.active.add(match[1]);
      setTimeout(() => {
        void this.advance(match[1]).catch(() => {
        });
      }, 0);
      return { jobId: match[1] };
    });
    if (action === "cancel") return this.lock(key, async () => {
      const g2 = await this.get(key);
      this.owns(peer, g2);
      if (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(g2.state)) {
        g2.state = "CANCEL_REQUESTED";
        await this.save(key, g2);
        this.active.add(match[1]);
      }
      return { jobId: match[1], state: g2.state };
    });
    const g = await this.get(key);
    this.owns(peer, g);
    if (action === "received") {
      if (g.state !== "SUCCEEDED" || body?.ref?.contentHash !== g.output?.ref.contentHash || body.bytes !== g.output?.bytes) throw Error("RESULT_ACK_INVALID");
      return { acknowledged: true };
    }
    return { jobId: match[1], state: g.state === "ACTIVE" ? "RUNNING" : g.state, deviceId: g.nodes.at(-1)?.target?.deviceId ?? peer.deviceId, targetId: g.nodes.at(-1)?.target?.targetId ?? "", outputTicket: g.state === "SUCCEEDED" ? await this.call("ticket", { peer, descriptor: g.output }) : null, error: g.error ?? null };
  }
  async restore() {
    for (const g of await this.call("list", { prefix: "graph:" })) if (["ACTIVE", "CANCEL_REQUESTED"].includes(g.state)) this.active.add(g.options.requestId);
  }
  async tick() {
    await Promise.all([...this.active].map((id2) => this.advance(id2).catch(() => {
    })));
  }
  async advance(id2) {
    if (this.locks.has("graph:" + id2)) return;
    await this.lock("graph:" + id2, async () => {
      const g = await this.get("graph:" + id2);
      if (!g) return;
      const before = JSON.stringify(g), peer = g.peer, now = this.port.now();
      if (now >= g.deadlineAt && g.state === "ACTIVE") {
        g.state = "CANCEL_REQUESTED";
        g.error = "BUDGET_EXHAUSTED";
      }
      if (g.state === "CANCEL_REQUESTED") {
        await Promise.all(g.nodes.filter((s) => s.state === "SUBMITTED").map((s) => this.call("cancel", { peer, id: s.jobId }).catch(() => {
        })));
        g.state = g.error ? "FAILED" : "CANCELLED";
        this.active.delete(id2);
        await this.save("graph:" + id2, g);
        return;
      }
      if (g.state !== "ACTIVE") {
        this.active.delete(id2);
        return;
      }
      const submitted = g.nodes.filter((s) => s.state === "SUBMITTED"), observed = submitted.length ? await this.call("inspectMany", { peer, ids: submitted.map((s) => s.jobId) }) : [];
      await Promise.all(submitted.map(async (s, index) => {
        const j = observed[index];
        s.target = j.offer?.target;
        s.reason = j.offer?.reasonCode;
        s.decision = j.decision ? JSON.parse(j.decision) : null;
        s.executionState = j.state;
        if (j.state === "SUCCEEDED" && j.output) {
          s.state = "COMMITTED";
          s.output = j.output;
          return;
        }
        const unstarted = j.state === "REJECTED" && j.rejection?.record === null && ["RESOURCE_UNAVAILABLE", "CREDIT_UNAVAILABLE", "QUEUE_STARVED_NOT_STARTED"].includes(j.rejection?.reasonCode);
        const restart = ["CANCELLED_SETTLED", "YIELDED"].includes(j.state) && j.restartable === true;
        if (g.state === "ACTIVE" && (unstarted || restart) && (s.retries ?? 0) < 8 && this.port.now() < g.deadlineAt) {
          const reason = restart ? j.yieldNotice?.reasonCode ?? j.state : j.rejection.reasonCode;
          s.attempts = [...s.attempts ?? [], { jobId: s.jobId, state: j.state, reason }];
          s.retries = (s.retries ?? 0) + 1;
          s.jobId = id2 + "." + s.id + ".r" + s.retries;
          s.state = "PENDING";
          s.executionState = "PENDING";
          s.retryAt = this.port.now() + Math.min(1e3, 100 * s.retries);
          s.waitReason = reason;
          return;
        }
        if (["FAILED", "REJECTED", "CANCELLED", "CANCELLED_SETTLED", "YIELDED", "SIDE_EFFECT_UNKNOWN", "HOLDER_RECORD_MISSING"].includes(j.state)) {
          g.state = "CANCEL_REQUESTED";
          g.error = "NODE_" + s.id + "_" + j.state;
        }
      }));
      if (g.state === "ACTIVE") for (const n of g.workflow.nodes) {
        const s = g.nodes.find((x) => x.id === n.id);
        if (s.state !== "PENDING" || (s.retryAt ?? 0) > this.port.now() || n.dependsOn.some((d) => g.nodes.find((v) => v.id === d).state !== "COMMITTED")) continue;
        try {
          let source = n.input ? g.input : n.inputFrom ? g.nodes.find((x) => x.id === n.inputFrom).output : s.input;
          if (!source) {
            source = await this.call("bundle", { peer, id: "bundle-" + s.jobId, parts: n.inputFroms.map((d) => ({ nodeId: d, descriptor: g.nodes.find((x) => x.id === d).output })) });
            s.input = source;
          }
          const contract = await this.call("contract", { capability: n.capability });
          const child = { ...n, input: { ...source.ref, bytes: source.bytes }, dependsOn: [] };
          delete child.inputFrom;
          delete child.inputFroms;
          delete child.input.artifactId;
          delete child.input.contentVersion;
          const submission = { workflow: { version: 3, id: s.jobId, outputContract: contract.contract.outputSchemas[0], qualityTarget: "reference", nodes: [child] }, options: { ...g.options, requestId: s.jobId, budgetMs: Math.max(1, Math.floor(g.deadlineAt - this.port.now())) } };
          const result = await this.call("dispatch", { peer, submission, source, sourceLocal: !!g.originLocal && !!n.input });
          s.target = result.target;
          s.state = "SUBMITTED";
        } catch (e) {
          const error = e.message;
          if (!["NO_LEGAL_PLAN", "INPUT_NOT_UPLOADED", "BUDGET_UNAVAILABLE", "TARGET_UNAVAILABLE"].includes(error)) {
            g.state = "CANCEL_REQUESTED";
            g.error = error;
          }
          s.waitReason = error;
        }
      }
      if (g.nodes.every((s) => s.state === "COMMITTED")) {
        g.state = "SUCCEEDED";
        g.output = g.nodes.at(-1).output;
        this.active.delete(id2);
      }
      if (JSON.stringify(g) !== before) await this.save("graph:" + id2, g);
    });
  }
  async photo(peerJson, inputJson) {
    const peer = JSON.parse(peerJson), m = JSON.parse(inputJson);
    if (!peer.app?.allowedContracts.includes("photo.enhance.v1")) throw Error("PHOTO_APP_REQUIRED");
    const match = /^\/photo-runs(?:\/([A-Za-z0-9-]+)(?:\/(input|capture-result|result)\?image=(\d+))?)?$/.exec(m.route);
    if (!match) throw Error("PHOTO_ROUTE_INVALID");
    let id2 = match[1];
    if (!id2) {
      if (m.method === "POST") {
        const b = m.body;
        if (!Array.isArray(b.inputs) || !b.inputs.length || b.inputs.length > 8 || b.mode !== "COOPERATIVE" || !Number.isInteger(b.budgetMs) || b.budgetMs < 1 || b.budgetMs > 3e5) throw Error("PHOTO_RUN_INVALID");
        for (const i of b.inputs) if (!/^[a-f0-9]{64}$/.test(i.hash) || !Number.isInteger(i.bytes) || i.bytes < 1 || i.bytes > 8388608) throw Error("PHOTO_INPUT_INVALID");
        id2 = this.port.id();
        const r = { ...b, id: id2, peer, sourceDeviceId: peer.deviceId, group: peer.groupId, createdAt: this.port.now(), updatedAt: this.port.now(), state: "PREPARING", revision: 0, inputReady: [], jobs: [], deliveries: [], scale: 4, model: (await this.call("contract", { capability: "photo.enhance.v1" })).model };
        await this.save("photo:" + id2, r);
        return JSON.stringify(r);
      }
      throw Error("PHOTO_ROUTE_INVALID");
    }
    return this.lock("photo:" + id2, async () => {
      const r = await this.get("photo:" + id2);
      this.owns(peer, r);
      const index = Number(match[3]);
      if (match[2]) {
        if (!r.inputs[index]) throw Error("PHOTO_INPUT_INVALID");
        if (match[2] === "input" && m.method === "PUT") {
          await this.call("validateBytes", { data: m.data, hash: r.inputs[index].hash, bytes: r.inputs[index].bytes });
          await this.save("photo-input:" + id2 + ":" + index, m.data);
          r.inputReady = [.../* @__PURE__ */ new Set([...r.inputReady ?? [], index])];
          r.updatedAt = this.port.now();
          await this.save("photo:" + id2, r);
          return "{}";
        }
        if (match[2] === "capture-result") {
          const j = r.jobs.find((j2) => j2.imageIndex === index), g = j && await this.get("graph:" + j.id);
          this.owns(peer, g);
          if (g.state !== "SUCCEEDED") throw Error("PHOTO_RESULT_PENDING");
          const product = await this.call("product", { descriptor: g.output });
          await this.save("photo-result:" + id2 + ":" + index, product);
          return '{"retained":true}';
        }
        throw Error("PHOTO_ROUTE_INVALID");
      }
      if (m.method === "GET") return JSON.stringify(await this.photoView(r));
      const b = m.body;
      if (b.revision !== r.revision) throw Error("PHOTO_RUN_REVISION");
      if (b.jobs) {
        if (b.jobs.length > r.inputs.length || new Set(b.jobs.map((j) => j.imageIndex)).size !== b.jobs.length) throw Error("PHOTO_JOB_SCOPE");
        for (const j of b.jobs) {
          const g = await this.get("graph:" + j.id);
          this.owns(peer, g);
          if (!r.inputs[j.imageIndex] || g.input.ref.contentHash !== r.inputs[j.imageIndex].hash) throw Error("PHOTO_JOB_SCOPE");
        }
        r.jobs = b.jobs;
      }
      if (b.deliveredImage) {
        const i = b.deliveredImage.imageIndex, p = await this.get("photo-result:" + id2 + ":" + i);
        if (!p || p.hash !== b.deliveredImage.hash) throw Error("PHOTO_RESULT_PENDING");
        if (!r.deliveries.some((v) => v.imageIndex === i)) r.deliveries.push({ ...b.deliveredImage, receivedAt: this.port.now() });
      }
      if (b.sourceDurationMs !== void 0 && (!Number.isFinite(b.sourceDurationMs) || b.sourceDurationMs < 0)) throw Error("PHOTO_DURATION_INVALID");
      if (b.state === "SUCCEEDED" && (!(await this.photoView(r)).allCommitted || r.deliveries.length !== r.inputs.length)) throw Error("PHOTO_RESULTS_NOT_COMMITTED");
      if (b.state && !["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"].includes(b.state)) throw Error("PHOTO_STATE_INVALID");
      for (const k of ["state", "error", "sourceDurationMs"]) if (b[k] !== void 0) r[k] = b[k];
      r.revision++;
      r.updatedAt = this.port.now();
      await this.save("photo:" + id2, r);
      return JSON.stringify(r);
    });
  }
  async photoView(r) {
    const workflows = [];
    for (const j of r.jobs) {
      const g = await this.get("graph:" + j.id);
      if (!g) continue;
      workflows.push({ id: j.id, imageIndex: j.imageIndex, state: g.state, nodes: g.workflow.nodes.map((n) => {
        const s = g.nodes.find((x) => x.id === n.id);
        return { ...n, state: s.state === "COMMITTED" ? "SUCCEEDED" : s.executionState ?? s.state, committed: s.state === "COMMITTED", target: s.target, reason: s.reason ?? s.waitReason, decision: s.decision, attemptId: s.jobId, retries: s.retries ?? 0, attempts: s.attempts ?? [] };
      }) });
    }
    return { ...r, workflows, allCommitted: workflows.length === r.inputs.length && workflows.every((w) => w.state === "SUCCEEDED"), images: r.inputs.map((_, imageIndex) => ({ imageIndex, delivered: r.deliveries.some((d) => d.imageIndex === imageIndex) })) };
  }
  async graphs(id2) {
    return !!await this.get("graph:" + id2);
  }
  async views() {
    const rows = await this.call("list", { prefix: "photo:" });
    return JSON.stringify(await Promise.all(rows.map((r) => this.photoView(r))));
  }
  async record(key) {
    return JSON.stringify(await this.get(key));
  }
  async display(path, bodyJson, key, address, devicesJson) {
    return this.lock("display", async () => {
      let session = await this.get("display-session");
      if (!session) {
        session = { key: (this.port.id() + this.port.id()).replace(/-/g, "").slice(0, 36), generation: 0, hiddenBefore: 0, seq: 0 };
        await this.save("display-session", session);
      }
      const body = bodyJson ? JSON.parse(bodyJson) : {}, devices = JSON.parse(devicesJson);
      const connection = () => ({ invitation: address + "/#display=" + session.key, generation: session.generation });
      if (path === "/session") return JSON.stringify(connection());
      if (path === "/reset") {
        session = { key: (this.port.id() + this.port.id()).replace(/-/g, "").slice(0, 36), generation: session.generation + 1, hiddenBefore: this.port.now(), seq: 0 };
        await this.save("display-session", session);
        return JSON.stringify(connection());
      }
      if (path === "/connect" || path === "/event") {
        if (key !== session.key) throw Error("DISPLAY_KEY_INVALID");
        if (path === "/connect") return JSON.stringify({ displayOnly: true, nextSeq: session.seq + 1 });
        const e = body;
        if (!["PICKING", "SELECTED", "START", "PROGRESS", "RESULT", "FINISH", "FAILED"].includes(e.type) || typeof e.runId !== "string" || e.runId.length > 128) throw Error("INVALID_EVENT");
        if (!Number.isInteger(e.seq) || e.seq < 1) throw Error("INVALID_SEQUENCE");
        if (e.seq <= session.seq) return JSON.stringify({ seq: session.seq });
        let r = await this.get("display-current");
        const now = this.port.now();
        if (e.type === "PICKING" || e.type === "SELECTED") {
          if (e.type === "SELECTED" && (!Array.isArray(e.inputs) || e.inputs.length > 8 || e.inputs.some((i) => !/^data:image\/jpeg;base64,/.test(i.preview) || i.preview.length > 2e5))) throw Error("INVALID_INPUTS");
          r = { id: "local:" + e.runId, runId: e.runId, kind: "LOCAL", label: "\u624B\u673A\u672C\u673A", state: e.type, createdAt: now, inputs: e.inputs ?? [], results: [], devices: [{ id: "phone", name: "\u624B\u673A CPU" }], workflows: [], revision: 0, evidence: "SOURCE_APP_REPORTED" };
        } else if (!r || r.runId !== e.runId) throw Error("RUN_MISMATCH");
        if (e.type === "START") {
          r.state = "RUNNING";
          r.createdAt = now;
          r.results = [];
        }
        if (e.type === "PROGRESS") Object.assign(r, { phase: e.phase, imageIndex: e.imageIndex, completed: e.completed, total: e.total });
        if (e.type === "RESULT") {
          if (r.state !== "RUNNING" || !r.inputs[e.imageIndex] || e.product.width !== r.inputs[e.imageIndex].width * 4 || e.product.height !== r.inputs[e.imageIndex].height * 4) throw Error("RESULT_GEOMETRY");
          await this.call("validateBytes", { data: e.product.image, hash: e.product.hash });
          if (!r.results.some((p) => p.imageIndex === e.imageIndex)) r.results.push({ imageIndex: e.imageIndex, ...e.product });
        }
        if (e.type === "FINISH") {
          if (r.results.length !== r.inputs.length || !Number.isFinite(e.durationMs) || e.durationMs < 0) throw Error("INCOMPLETE_RUN");
          r.state = "SUCCEEDED";
          r.durationMs = e.durationMs;
        }
        if (e.type === "FAILED") {
          r.state = "FAILED";
          r.error = e.error;
          r.durationMs = e.durationMs;
        }
        r.revision++;
        r.updatedAt = now;
        await this.save("display-current", r);
        await this.save("display-run:" + r.runId, r);
        session.seq = e.seq;
        await this.save("display-session", session);
        return JSON.stringify({ seq: e.seq });
      }
      const imageUrl = (id2, i, k) => "/images/" + encodeURIComponent(id2) + "/" + i + "/" + k;
      const localView = (r) => ({ ...r, inputs: r.inputs.map((i, n) => ({ ...i, preview: void 0, originalHash: i.hash, url: imageUrl(r.id, n, "input") })), results: r.results.map((p) => ({ ...p, image: void 0, url: imageUrl(r.id, p.imageIndex, "result") })) });
      const coopView = (r) => {
        const id2 = "coop:" + r.id, nodes = r.workflows.flatMap((w) => w.nodes), used = r.usedDeviceIds ?? [...new Set(nodes.filter((n) => n.target && ["SUCCEEDED", "ACCEPTED", "RUNNING"].includes(n.state)).map((n) => n.target.deviceId))];
        return { ...r, peer: void 0, id: id2, kind: "COOPERATIVE", label: "\u591A\u8BBE\u5907\u534F\u540C", durationMs: ["SUCCEEDED", "FAILED", "CANCELLED"].includes(r.state) ? r.sourceDurationMs : null, inputs: r.inputs.map((i, n) => ({ ...i, url: r.inputReady === void 0 || r.inputReady.includes(n) ? imageUrl(id2, n, "input") : null })), results: r.deliveries.map((d) => ({ ...d, url: imageUrl(id2, d.imageIndex, "result") })), devices: used.map((id3) => ({ id: id3, name: devices.find((d) => d.id === id3)?.title ?? id3 })), directory: devices.map((d) => ({ id: d.id, name: d.title })), evidence: "COORDINATOR_RECEIPTS" };
      };
      if (path === "/runs") {
        const local = await this.call("list", { prefix: "display-run:" }), cooperative = await this.call("list", { prefix: "photo:" });
        const runs = [...local.map(localView), ...await Promise.all(cooperative.map(async (r) => {
          let summary = this.summaries.get(r.id);
          if (!summary || summary.revision !== r.revision || !["SUCCEEDED", "FAILED", "CANCELLED"].includes(r.state) && this.port.now() - summary.at > 2e3) {
            const view = await this.photoView(r);
            summary = { revision: r.revision, at: this.port.now(), devices: [...new Set(view.workflows.flatMap((w) => w.nodes).filter((n) => n.target && ["SUCCEEDED", "ACCEPTED", "RUNNING"].includes(n.state)).map((n) => n.target.deviceId))] };
            if (this.summaries.size > 100) this.summaries.clear();
            this.summaries.set(r.id, summary);
          }
          return coopView({ ...r, workflows: [], usedDeviceIds: summary.devices });
        }))].filter((r) => r.createdAt >= session.hiddenBefore).sort((a, b) => b.createdAt - a.createdAt);
        return JSON.stringify({ generation: session.generation, managed: true, coordinator: { connected: true, name: "\u9E3F\u8499\u534F\u8C03\u4E2D\u5FC3" }, runs: runs.map((r) => ({ ...r, results: void 0, workflows: void 0 })) });
      }
      if (path.startsWith("/runs/")) {
        const id2 = decodeURIComponent(path.slice(6));
        if (id2.startsWith("local:")) {
          const r2 = await this.get("display-run:" + id2.slice(6));
          if (!r2 || r2.createdAt < session.hiddenBefore) throw Error("RUN_NOT_FOUND");
          return JSON.stringify(localView(r2));
        }
        const r = await this.get("photo:" + id2.slice(5));
        if (!r || r.createdAt < session.hiddenBefore) throw Error("RUN_NOT_FOUND");
        return JSON.stringify(coopView(await this.photoView(r)));
      }
      const m = /^\/images\/([^/]+)\/(\d+)\/(input|result)$/.exec(path);
      if (m) {
        const id2 = decodeURIComponent(m[1]), i = Number(m[2]);
        if (id2.startsWith("local:")) {
          const r2 = await this.get("display-run:" + id2.slice(6));
          if (!r2 || r2.createdAt < session.hiddenBefore) throw Error("RUN_NOT_FOUND");
          const data = m[3] === "input" ? r2.inputs[i]?.preview.split(",")[1] : r2.results.find((v) => v.imageIndex === i)?.image;
          if (!data) throw Error("IMAGE_NOT_FOUND");
          return JSON.stringify({ data, mime: m[3] === "input" ? "image/jpeg" : "image/png" });
        }
        const rid = id2.slice(5), r = await this.get("photo:" + rid);
        if (!r || r.createdAt < session.hiddenBefore || !r.inputs[i]) throw Error("RUN_NOT_FOUND");
        if (m[3] === "result" && !r.deliveries.some((v) => v.imageIndex === i)) throw Error("PHOTO_RESULT_PENDING");
        const p = await this.get("photo-" + m[3] + ":" + rid + ":" + i);
        if (!p) throw Error("IMAGE_NOT_FOUND");
        return JSON.stringify({ data: typeof p === "string" ? p : p.image, mime: "image/png" });
      }
      throw Error("DISPLAY_ROUTE_NOT_FOUND");
    });
  }
};

// <stdin>
function planJson(snapshot, request, policy, now, monotonic) {
  return JSON.stringify(plan(JSON.parse(snapshot), JSON.parse(request), JSON.parse(policy), { now, monotonic }));
}
function availabilityJson(profile, executor, priority, version, now) {
  return JSON.stringify(availability(JSON.parse(profile), JSON.parse(executor), priority, version, now));
}
export {
  NativePhotoEngine,
  availabilityJson,
  nativePlanJson,
  planJson
};
