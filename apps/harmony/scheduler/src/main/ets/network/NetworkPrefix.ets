// Stable subnet identity: never retain host addresses or OS connection handles.
export function networkPrefix(address: string, prefixLength: number): string | undefined {
  if (!Number.isInteger(prefixLength) || prefixLength < 0) { return undefined; }
  if (address.indexOf(':') < 0) {
    const parts = address.split('.');
    if (parts.length !== 4 || prefixLength > 32) { return undefined; }
    const numbers = parts.map((part: string): number => Number(part));
    if (numbers.some((part: number): boolean => !Number.isInteger(part) || part < 0 || part > 255)) { return undefined; }
    const masked = numbers.map((part: number, index: number): number => {
      const bits = Math.max(0, Math.min(8, prefixLength - index * 8));
      return part & (bits === 0 ? 0 : 256 - Math.pow(2, 8 - bits));
    });
    return masked.join('.') + '/' + prefixLength.toString();
  }
  if (prefixLength > 128) { return undefined; }
  const halves = address.split('%')[0].toLowerCase().split('::');
  if (halves.length > 2) { return undefined; }
  const left = halves[0] === '' ? [] : halves[0].split(':');
  const right = halves.length < 2 || halves[1] === '' ? [] : halves[1].split(':');
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) { return undefined; }
  const words = left.concat(Array<string>(missing).fill('0'), right);
  if (words.some((word: string): boolean => !/^[0-9a-f]{1,4}$/.test(word))) { return undefined; }
  // Privacy addresses rotate within /64. Shorter routing prefixes remain distinguishable.
  const bits = Math.min(64, prefixLength);
  const prefix = words.slice(0, 4).map((word: string, index: number): string => {
    const retained = Math.max(0, Math.min(16, bits - index * 16));
    const mask = retained === 0 ? 0 : 65536 - Math.pow(2, 16 - retained);
    return (parseInt(word, 16) & mask).toString(16);
  });
  return prefix.join(':') + '::/' + bits.toString();
}
