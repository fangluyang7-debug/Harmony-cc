export const available: () => boolean;
export const run: (param: string, weights: string, input: string, output: string, threads?: number) => Promise<void>;

export const cpuCount: () => number;
