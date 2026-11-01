/** Canonical control metadata only. No I/O, clocks, platform APIs or business identities. */
export function canonical(value: Object | null): string {
  if (Array.isArray(value)) return '[' + value.map((item: Object | null) => canonical(item)).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, Object | null>;
    return '{' + Object.keys(value).filter((key: string) => record[key] !== undefined).sort()
      .map((key: string) => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}
