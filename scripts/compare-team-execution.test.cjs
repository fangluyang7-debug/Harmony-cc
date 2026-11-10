const {test} = require('node:test');
const assert = require('node:assert/strict');
const {compare} = require('./compare-team-execution.cjs');
const options = {targets: ['a', 'b', 'c'], capability: 'text.count.v1', inputSchema: 'text.input',
  outputSchema: 'text.counts', bytes: Buffer.from('input'), expected: Buffer.from('answer'), count: 3, concurrency: 1, rounds: 2};
function fake(output = 'answer') {
  const submissions = [];
  return {submissions, registerInput: async () => ({}), submit: async (workflow, opts) => {
    submissions.push({workflow, opts});
    const target = workflow.nodes[0].targetId ?? ['a', 'b', 'c'][submissions.length % 3];
    return {result: async () => ({output: Buffer.from(output), status: {targetId: target, deviceId: target, traceId: opts.requestId}})};
  }};
}
test('comparison pins each baseline, leaves team selection to SDK, rotates order and preserves traces', async () => {
  const sdk = fake(), report = await compare(sdk, options);
  assert.equal(report.batches.length, 8);
  assert.equal(sdk.submissions.length, 24);
  assert.deepEqual(report.batches.map(b => b.mode), ['a', 'b', 'c', 'TEAM', 'b', 'c', 'TEAM', 'a']);
  assert.equal(report.teamDevices.length, 3);
  assert.equal(new Set(sdk.submissions.map(s => s.opts.requestId)).size, 24);
  assert.ok(report.batches.every(b => b.samples.every(s => s.traceId && s.state === 'PASS')));
});
test('wrong results stop subsequent batches and cannot produce a speedup', async () => {
  const sdk = fake('wrong'), report = await compare(sdk, options);
  assert.equal(report.verdict, 'FAILED');
  assert.equal(report.speedup, null);
  assert.equal(sdk.submissions.length, 1);
  assert.equal(report.batches[0].samples[0].error, 'RESULT_MISMATCH');
});
test('unknown submission delivery is retained without another logical submission', async () => {
  const sdk = fake(); sdk.submit = async () => {throw Error('SDK_REQUEST_TIMEOUT');};
  const report = await compare(sdk, options);
  assert.equal(report.verdict, 'FAILED');
  assert.equal(report.batches.length, 1);
  assert.equal(report.batches[0].samples[0].error, 'SDK_REQUEST_TIMEOUT');
});
