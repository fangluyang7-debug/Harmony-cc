const fs = require('node:fs');
const path = require('node:path');
const [directory, ...targets] = process.argv.slice(2);
if (!directory || !targets.length) throw Error('Usage: node scripts/prepare-document-demo.cjs <new-directory> <targetId> [targetId ...]');
const root = path.resolve(directory);
fs.mkdirSync(root); // An existing dataset is never overwritten.
const documents = [];
for (let i = 0; i < 12; i++) {
  const repetitions = 20000 + i * 500;
  const inputFile = path.join(root, `document-${i}.json`);
  const expectedFile = path.join(root, `expected-${i}.json`);
  fs.writeFileSync(inputFile, JSON.stringify({text: 'harmony team\n'.repeat(repetitions)}));
  // Independent arithmetic oracle for this generated, declared demonstration corpus.
  fs.writeFileSync(expectedFile, JSON.stringify({characters: 13 * repetitions, words: 2 * repetitions, lines: repetitions + 1}));
  documents.push({inputFile, expectedFile});
}
fs.writeFileSync(path.join(root, 'workload.json'), JSON.stringify({
  capability: 'text.count.v1', inputSchema: 'text.input', outputSchema: 'text.counts',
  targets, documents, count: documents.length, concurrency: 3, rounds: 3
}, null, 2));
console.log('Prepared 12 synthetic documents with independent expected counts. workload.json is ready.');
