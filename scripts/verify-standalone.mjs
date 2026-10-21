import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => JSON.parse(readFileSync(resolve(root, path), 'utf8').replace(/^\uFEFF/, ''));
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const inside = path => {
  const value = relative(root, path);
  return value !== '..' && !value.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(value);
};
assert.equal(realpathSync(git('rev-parse', '--show-toplevel')), realpathSync(root), 'Project must own its Git root');
assert(!/github\.com[:/]fangluyang7-debug\/Cixin(?:\.git)?(?:\s|$)/i.test(git('remote', '-v')), 'Old Cixin origin must not be inherited');
const pkg = read('package.json'), lock = read('package-lock.json');
assert.equal(pkg.name, 'harmony-cc');
assert.equal(lock.name, pkg.name);
assert.equal(lock.packages[''].name, pkg.name);
for (const workspace of pkg.workspaces) {
  const location = resolve(root, workspace);
  assert(inside(location) && inside(realpathSync(location)), 'Workspace escapes repository');
  const child = read(`${workspace}/package.json`);
  assert.equal(lock.packages[workspace].name, child.name);
  for (const section of ['dependencies', 'devDependencies']) {
    assert.deepEqual(lock.packages[workspace][section] ?? {}, child[section] ?? {});
    for (const spec of Object.values(child[section] ?? {})) {
      if (spec.startsWith('file:')) assert(inside(resolve(location, spec.slice(5))), 'File dependency escapes repository');
    }
  }
}
const required = [
  'apps/harmony/entry/src/main/ets/entryability/EntryAbility.ets',
  'apps/harmony/scheduler/Index.ets',
  'apps/harmony/entry/src/main/ets/services/CloudShoppingExecutor.ets',
  'apps/harmony/entry/src/main/ets/pages/CloudPhoneDispatchPage.ets',
  'apps/harmony/entry/src/main/resources/rawfile/soleai_neural_embedding_v1.ms',
  'apps/harmony/entry/src/main/resources/rawfile/soleai_neural_embedding_v1.json',
  'apps/harmony/monitor/server.mjs',
  'services/api-server/src/core/runtime/workflow-placement-planner.ts',
  'services/api-server/src/modules/runtime/phone-dispatch.service.ts',
  'services/api-server/prisma/schema.prisma',
  'services/device-worker/server.mjs', 'services/image-worker/app/main.py',
  'contracts/shopping/v1/schemas.json', 'contracts/scheduling/v1/fixtures.json',
  'apps/harmony/build-profile.template.json5',
  '提交文件/复赛/智调鸿枢复赛项目说明_参考文献与标题修订版.docx',
  '提交文件/复赛/智调鸿枢全面真机验收测试报告.docx',
];
for (const item of required) assert(existsSync(resolve(root, item)), `Required chain file missing: ${item}`);
const inventory = read('docs/migration/Harmony-cc-repository-manifest.json');
let drift = 0;
for (const entry of inventory.files) {
  const path = resolve(root, entry.path);
  assert(inside(path) && existsSync(path), `Missing preserved file: ${entry.path}`);
  const bytes = readFileSync(path);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const normalized = entry.lineEndingNormalizedSha256 === undefined ? null :
    createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
  if (hash !== entry.sha256 && normalized !== entry.lineEndingNormalizedSha256) drift++;
}
if (process.argv.includes('--exact')) assert.equal(drift, 0, 'Files differ from repository migration baseline');
console.log(`Independent Git root and workspace identity verified; ${required.length} chain anchors present; ${inventory.files.length} preserved repository files present; ${drift} changed since migration baseline.`);
console.log('Local credentials, signing, generated caches and archived duplicate packages are intentionally outside the clone manifest.');
