import {number, traceGroups} from './dispatch-view.mjs';

// Ratios describe declared admission capacity, never whole-machine utilization.
export function capacity(occupied, limit) {
  if (!number(occupied) || occupied < 0 || !number(limit) || limit <= 0) return null;
  const percent = occupied / limit * 100;
  return {percent, fill: Math.min(100, percent), exceeded: occupied > limit};
}

// Independent axes: monotonic timestamps from different clocks are never aligned.
export function clockLanes(spans) {
  return traceGroups(spans).map(group => {
    const valid = group.spans.filter(s => number(s.startMono) && number(s.durationMs) && s.durationMs >= 0);
    const origin = valid.length ? Math.min(...valid.map(s => s.startMono)) : 0;
    const extent = valid.length ? Math.max(...valid.map(s => s.startMono - origin + s.durationMs)) : 0;
    return {...group, extent, rows: group.spans.map(span => ({span,
      offset: valid.includes(span) ? span.startMono - origin : null,
      left: valid.includes(span) && extent > 0 ? (span.startMono - origin) / extent * 100 : 0,
      width: valid.includes(span) && extent > 0 ? span.durationMs / extent * 100 : 0
    }))};
  });
}

export function costScale(values) {
  const valid = values.filter(v => number(v) && v >= 0), max = Math.max(0, ...valid);
  return values.map(v => !number(v) || v < 0 ? null : max === 0 ? 0 : v / max * 100);
}

export function networkLevels(states) {
  const counts = {L0:0,L1:0,L2:0,L3:0,UNKNOWN:0};
  for (const state of states) counts[Object.hasOwn(counts,state.level) ? state.level : 'UNKNOWN']++;
  return counts;
}
