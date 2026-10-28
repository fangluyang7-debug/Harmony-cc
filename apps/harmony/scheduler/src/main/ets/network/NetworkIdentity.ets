import connection from '@ohos.net.connection';
import cryptoFramework from '@ohos.security.cryptoFramework';
import util from '@ohos.util';

interface NetworkFingerprint {
  netId: number;
  bearers: number[];
  interfaceName: string;
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
      netId: handle.netId,
      bearers: capabilities.bearerTypes.slice().sort((a: number, b: number): number => a - b),
      interfaceName: properties.interfaceName,
      addresses: properties.linkAddresses.map((value: connection.LinkAddress): string =>
        value.address.address + '/' + value.prefixLength.toString()).sort()
    };
    const md = cryptoFramework.createMd('SHA256');
    await md.update({ data: new util.TextEncoder().encodeInto(JSON.stringify(fingerprint)) });
    const digest = await md.digest();
    return Array.from(digest.data).map((value: number): string => value.toString(16).padStart(2, '0')).join('');
  } catch (_) { return undefined; }
}

// Fail to an unknown network instead of reusing a stale identity or blocking heartbeat indefinitely.
export async function sampleNetworkIdentity(): Promise<string | undefined> {
  let timer: number = -1;
  const timeout = new Promise<string | undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), 500);
  });
  try { return await Promise.race([readNetworkIdentity(), timeout]); }
  finally { if (timer >= 0) { clearTimeout(timer); } }
}
