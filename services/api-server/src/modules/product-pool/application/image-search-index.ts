import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ModelManifestV2, validModelManifestV2, sameModelV2 } from '@harmony/scheduler-core';

interface Entry { productId: string; vector: number[]; category?: string }
export interface ImageIndex {
  indexSpaceId: string; version: string; model: ModelManifestV2; entries: Entry[];
}
export interface QualityCase { vector: number[]; expectedProductId: string }
export function safeIndexId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,95}$/.test(value);
}
export function validQueryVector(value: unknown, dimension: number): value is number[] {
  if (!Array.isArray(value) || value.length !== dimension || !value.every(Number.isFinite)) return false;
  return Math.abs(value.reduce((sum, x) => sum + x*x, 0) - 1) <= 0.002;
}
export function rank(index: ImageIndex, vector: number[], topK: number, category?: string) {
  return index.entries.filter(entry => category === undefined || entry.category === category)
    .map(entry => ({productId: entry.productId, score: entry.vector.reduce((sum, x, i) => sum+x*vector[i], 0)}))
    .sort((a,b) => b.score-a.score || a.productId.localeCompare(b.productId)).slice(0, topK);
}
function validate(index: ImageIndex) {
  if (!index || !safeIndexId(index.indexSpaceId) || !safeIndexId(index.version) ||
      !validModelManifestV2(index.model) || index.model.dtype !== 'float32' || index.model.normalization !== 'l2' ||
      !Array.isArray(index.entries) || !index.entries.length) throw Error('IMAGE_V2_INDEX_INVALID');
  const ids = new Set<string>();
  for (const entry of index.entries) {
    if (!entry || typeof entry.productId !== 'string' || !entry.productId.trim() || ids.has(entry.productId) ||
        (entry.category !== undefined && typeof entry.category !== 'string') ||
        !validQueryVector(entry.vector,index.model.dimension)) throw Error('IMAGE_V2_INDEX_INVALID');
    ids.add(entry.productId);
  }
}
export async function activateIndex(root: string, index: ImageIndex, cases: QualityCase[]) {
  validate(index);
  if (!Array.isArray(cases) || !cases.length || !cases.every(c => c && validQueryVector(c.vector,index.model.dimension) &&
      rank(index,c.vector,1)[0]?.productId === c.expectedProductId)) throw Error('IMAGE_V2_QUALITY_FAILED');
  const directory = join(root,index.indexSpaceId);
  await mkdir(directory,{recursive:true});
  const bytes = JSON.stringify(index);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const staging = join(directory,randomUUID()+'.staging');
  try {
    await writeFile(staging,bytes,{flag:'wx'});
    await rename(staging,join(directory,digest+'.json'));
    await writeFile(staging,digest,{flag:'wx'});
    await rename(staging,join(directory,'active'));
  } finally { await rm(staging,{force:true}); }
  return digest;
}
export async function loadIndex(root: string, space: string, model?: ModelManifestV2): Promise<ImageIndex> {
  if (!safeIndexId(space)) throw Error('IMAGE_V2_INPUT_INVALID');
  let index: ImageIndex;
  try {
    const directory = join(root,space);
    const digest = await readFile(join(directory,'active'),'utf8');
    if (!/^[0-9a-f]{64}$/.test(digest)) throw Error();
    const bytes = await readFile(join(directory,digest+'.json'));
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw Error();
    index=JSON.parse(bytes.toString());
    validate(index);
    if (index.indexSpaceId !== space) throw Error();
  } catch { throw Error('IMAGE_V2_INDEX_UNAVAILABLE'); }
  if (model !== undefined && !sameModelV2(index.model,model)) throw Error('IMAGE_V2_MODEL_MISMATCH');
  return index;
}
