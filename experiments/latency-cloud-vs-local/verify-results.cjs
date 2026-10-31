const fs = require('node:fs'), assert = require('node:assert/strict');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const cleanup = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : null;
assert.ok(report.finishedAt, 'Run must be complete');
assert.equal(report.samples.length, 426);
assert.equal(report.warmups.length, 6);
const expected = { 'https-new-connection': 15, 'https-keepalive': 60, dashboard: 30, 'websocket-ping': 60, 'text-tiny': 15, 'text-256k': 15, 'vector-4096x8': 15, 'pause-applied': 3 };
for (const env of ['local', 'cloud']) {
  assert.ok(report.cleanup.some(x => x.env === env && x.agentStopped));
  assert.ok(report.cleanup.some(x => x.env === env && x.credentialRevoked) || cleanup?.checks.some(x => x.env === env && (env === 'local' ? x.allRevoked : x.credentialRejected)));
  for (const [scenario, count] of Object.entries(expected)) {
    const rows = report.samples.filter(x => x.env === env && x.scenario === scenario);
    assert.equal(rows.length, count, env + '/' + scenario);
    const summary = report.summary.find(x => x.env === env && x.scenario === scenario);
    assert.equal(summary.failed, rows.filter(x => !x.ok).length);
    for (const [metric, stats] of Object.entries(summary)) {
      if (!stats || typeof stats !== 'object' || !('median' in stats)) continue;
      const values = rows.filter(x => x.ok && Number.isFinite(x[metric])).map(x => x[metric]).sort((a, b) => a - b);
      assert.equal(stats.n, values.length);
      for (const [key, p] of [['median', .5], ['p95', .95]]) assert.equal(stats[key], Math.round(values[Math.ceil(values.length * p) - 1] * 100) / 100);
    }
  }
}
assert.equal(report.summary.length, 16);
console.log('PASS: counts, nearest-rank statistics, retained failures, and agent cleanup verified.');
console.log(JSON.stringify({ samples: report.samples.length, failed: report.samples.filter(x => !x.ok).length, agentDiagnostics: report.errors.length }));
