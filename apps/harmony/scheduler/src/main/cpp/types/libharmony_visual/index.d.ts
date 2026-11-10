export const match: (id: string, input: ArrayBuffer) => Promise<ArrayBuffer>;
export const cancel: (id: string) => void;
export const pack: (id: string, raw: ArrayBuffer) => Promise<ArrayBuffer>;
