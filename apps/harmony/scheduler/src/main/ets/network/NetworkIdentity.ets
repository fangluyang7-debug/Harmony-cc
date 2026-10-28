import connection from '@ohos.net.connection';
import cryptoFramework from '@ohos.security.cryptoFramework';
import util from '@ohos.util';
import { networkPrefix } from './NetworkPrefix';

interface NetworkFingerprint {
  bearers: number[];
  addresses: string[];
}

async function readNetworkIdentity(): Promise<string | undefined> {
  try {
    const handle = await connection.getDefaultNet();
    if (handle.netId <= 0) { return undefined; }
    const capabilities = await connection.getNetCapabilities(handle);
    const properties = await connection.getConnectionProperties(handle);
    const current = await connection.getDefaultNet();
    if (current.netId !== handle.netId) { return undefined; }
    const fingerprint: NetworkFingerprint = {
      bearers: capabilities.bearerTypes.slice().sort((a: number, b: number): number => a - b),
      addresses: properties.linkAddresses.map((value: connection.LinkAddress): string =>
        networkPrefix(value.address.address, value.prefixLength) ?? '').filter((value: string): boolean => value !== '').filter((value: string, index: number, values: string[]): boolean => values.indexOf(value) === index).sort()
    };
    if (fingerprint.addresses.length === 0) { return undefined; }
    const md = cryptoFramework.createMd('SHA256');
    await md.update({ data: new util.TextEncoder().encodeInto(JSON.stringify(fingerprint)) });
    const digest = await md.digest();
    return Array.from(digest.data).map((value: number): string => value.toString(16).padStart(2, '0')).join('');
  } catch (_) { return undefined; }
}

// Fail to an unknown network instead of reusing a stale identity or blocking heartbeat indefinitely.
async function timedIdentity(): Promise<string | undefined> {
  let timer: number = -1;
  const timeout = new Promise<string | undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), 500);
  });
  try { return await Promise.race([readNetworkIdentity(), timeout]); }
  finally { if (timer >= 0) { clearTimeout(timer); } }
}

let cached: string | undefined = undefined;
let refreshedAt: number = 0;
let generation: number = 0;
let pending: Promise<string | undefined> | undefined = undefined;
let monitor: connection.NetConnection | undefined = undefined;

function invalidateNetwork(): void {
  generation++;
  cached = undefined;
  refreshedAt = 0;
}

// Events invalidate immediately; a bounded periodic refresh also recovers missed events.
export async function sampleNetworkIdentity(): Promise<string | undefined> {
  if (monitor === undefined) {
    try {
      monitor = connection.createNetConnection();
      monitor.on('netAvailable', () => { invalidateNetwork(); });
      monitor.on('netLost', () => { invalidateNetwork(); });
      monitor.on('netCapabilitiesChange', () => { invalidateNetwork(); });
      monitor.on('netConnectionPropertiesChange', () => { invalidateNetwork(); });
      monitor.register(() => {});
    } catch (_) { monitor = undefined; }
  }
  if (Date.now() - refreshedAt < 30000) { return cached; }
  if (pending !== undefined) { return pending; }
  const current = generation;
  pending = timedIdentity().then((value: string | undefined): string | undefined => {
    if (current !== generation) { return undefined; }
    cached = value;
    refreshedAt = Date.now();
    return value;
  }).finally(() => { pending = undefined; });
  return pending;
}
