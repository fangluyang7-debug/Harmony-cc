import { readFile } from 'node:fs/promises';
import { activateIndex } from '../src/modules/product-pool/application/image-search-index';

async function main() {
  const [root, input, quality] = process.argv.slice(2);
  if (!root || !input || !quality) throw Error('Usage: build-image-index ROOT INDEX.json QUALITY_CASES.json');
  const index = JSON.parse(await readFile(input,'utf8'));
  const cases = JSON.parse(await readFile(quality,'utf8'));
  console.log(await activateIndex(root,index,cases));
}
main().catch(err => { console.error(err.message); process.exitCode=1; });
