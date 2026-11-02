export type PeerReachability='REACHABLE'|'PEER_UNREACHABLE'|'TLS_MISMATCH'|'TIMEOUT'|'EVIDENCE_MISSING'|'EVIDENCE_EXPIRED'|'NO_DATA_ENDPOINT';
export interface NetworkPairState {from:string;to:string;reason:PeerReachability;observedAt:number;expiresAt:number;}
/** Network tiers describe evidence, not assumptions about a router or operating system. */
export function networkState(coordinator:'REACHABLE'|'UNREACHABLE'|'UNKNOWN',pairs:NetworkPairState[],now:number){
  const current=pairs.map(p=>({...p,reason:![now,p.observedAt,p.expiresAt].every(Number.isFinite)||p.observedAt>now||p.expiresAt<=now?'EVIDENCE_EXPIRED' as PeerReachability:p.reason}));
  const reachable=current.filter(p=>p.reason==='REACHABLE').length;
  const level=coordinator!=='REACHABLE'?'L3':current.length>0&&reachable===current.length?'L0':reachable>0?'L1':'L2';
  const suggestions=level==='L3'?['检查协调者地址与网络连接；有条件时开启 PC 热点并重新配对。']:
    level==='L1'||level==='L2'?['可尝试让 PC 使用有线网络，或关闭路由器客户端隔离；操作后系统重新探测。']:[];
  return {level,coordinator,pairs:current,suggestions};
}
