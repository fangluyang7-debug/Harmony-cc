import { PlacementRequest, WorkflowPlacementDecision, WorkflowPlacementPlanner } from './workflow-placement-planner';

export type SelectionPolicy = 'CLOUD_BASELINE' | 'PEER_FASTEST' | 'BACKGROUND_CALIBRATION';
// Each comparison branch changes only this default; overrides make regression tests reproducible.
export const DEFAULT_SELECTION_POLICY: SelectionPolicy = 'BACKGROUND_CALIBRATION';

export function selectionPolicy(): SelectionPolicy {
  const value = process.env.SCHEDULING_SELECTION_POLICY ?? DEFAULT_SELECTION_POLICY;
  if (!['CLOUD_BASELINE', 'PEER_FASTEST', 'BACKGROUND_CALIBRATION'].includes(value)) {
    throw new Error('SCHEDULING_SELECTION_POLICY_INVALID');
  }
  return value as SelectionPolicy;
}

export function selectPlan(request: PlacementRequest, policy: SelectionPolicy,
  calibrationDeviceId?: string): WorkflowPlacementDecision {
  const planner = new WorkflowPlacementPlanner(policy === 'PEER_FASTEST' ? {
    maxCandidates: 8, lookahead: 16, beamWidth: 8, planningBudgetMs: 20,
    switchCostMs: 0, hysteresisMs: 0
  } : undefined);
  const normal = planner.plan(request);
  if (policy !== 'BACKGROUND_CALIBRATION' || !calibrationDeviceId) return normal;
  if (request.nodes.length !== 1 || request.nodes[0].capability !== 'image.crop.v1' ||
      calibrationDeviceId === 'cloud-runtime') throw new Error('CALIBRATION_SCOPE_INVALID');
  const forced = planner.plan({...request, nodes: request.nodes.map(node => ({...node,
    baselineDeviceId: calibrationDeviceId,
    candidates: node.candidates.filter(candidate => candidate.deviceId === calibrationDeviceId)
  }))});
  if (!forced.suggestion) throw new Error('CALIBRATION_TARGET_NOT_FEASIBLE');
  return {...forced, baseline: normal.baseline, baselineMs: normal.baselineMs,
    reason: 'BACKGROUND_CALIBRATION'};
}
