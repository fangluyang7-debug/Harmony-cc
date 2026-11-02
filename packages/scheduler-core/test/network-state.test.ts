import {networkState,NetworkPairState} from '../src/network-state';

const pair=(reason:NetworkPairState['reason']='REACHABLE'):NetworkPairState=>({from:'phone',to:'pc',reason,observedAt:100,expiresAt:200});
describe('network levels follow fresh directional evidence',()=>{
  it('degrades and recovers without assuming a network topology',()=>{
    expect(networkState('REACHABLE',[pair(),{...pair(),from:'pc',to:'phone'}],150).level).toBe('L0');
    expect(networkState('REACHABLE',[pair(),pair('TIMEOUT')],150).level).toBe('L1');
    expect(networkState('REACHABLE',[pair('PEER_UNREACHABLE')],150).level).toBe('L2');
    expect(networkState('UNREACHABLE',[pair()],150).level).toBe('L3');
    expect(networkState('REACHABLE',[pair()],150).level).toBe('L0');
  });
  it('does not turn missing, expired or invalid timestamps into reachability',()=>{
    expect(networkState('REACHABLE',[],150).level).toBe('L2');
    for(const p of [pair('EVIDENCE_MISSING'),{...pair(),expiresAt:150},{...pair(),observedAt:151},{...pair(),expiresAt:NaN}])
      expect(networkState('REACHABLE',[p],150).level).toBe('L2');
    expect(networkState('UNKNOWN',[pair()],150).level).toBe('L3');
  });
});
