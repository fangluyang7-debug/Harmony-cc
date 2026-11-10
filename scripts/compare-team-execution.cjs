const fs = require('node:fs');
const {randomUUID, createHash} = require('node:crypto');
const {performance} = require('node:perf_hooks');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Every mode uses the same SDK, input, parallelism and result verification.
// A pinned target measures single-device execution through the coordinator.
async function compare(sdk, options, save = () => {}) {
  const {targets, capability, inputSchema, outputSchema, bytes, expected,
    parameters = '{}', count = 12, concurrency = 3, rounds = 3} = options;
  const documents = options.documents ?? [{bytes, expected}];
  if (!Array.isArray(targets) || !targets.length || targets.some(t => typeof t !== 'string' || !t) ||
      new Set(targets).size !== targets.length || !capability || !inputSchema || !outputSchema ||
      !Array.isArray(documents) || !documents.length || documents.some(d => !Buffer.isBuffer(d.bytes) || !Buffer.isBuffer(d.expected)) ||
      ![count, concurrency, rounds].every(n => Number.isSafeInteger(n) && n > 0) ||
      count > 1000 || concurrency > 16 || rounds > 20) throw Error('COMPARISON_OPTIONS_INVALID');
  JSON.parse(parameters);
  const report = {version: 1, startedAt: new Date().toISOString(),
    boundary: 'SDK input registration through complete verified result, including transfer and polling',
    baseline: 'Each pinned execution target uses the same coordinator and SDK as automatic placement',
    documents: documents.map(d => ({inputSha256: hash(d.bytes), expectedSha256: hash(d.expected)})), capability, parameters,
    count, concurrency, rounds, targets, batches: [], verdict: 'INCOMPLETE', speedup: null};
  const modes = [...targets.map(targetId => ({name: targetId, targetId})), {name: 'TEAM'}];
  for (let round = 0; round < rounds; round++) {
    // Rotate mode order to avoid always measuring the team last after warm-up.
    const order = modes.slice(round % modes.length).concat(modes.slice(0, round % modes.length));
    for (const mode of order) {
      const batch = {round, mode: mode.name, samples: [], durationMs: null};
      report.batches.push(batch);
      const started = performance.now();
      let next = 0;
      async function worker() {
        while (next < count) {
          const index = next++, id = randomUUID(), start = performance.now();
          const documentIndex = index % documents.length;
          const document = documents[documentIndex];
          const sample = {index, documentIndex, jobId: id, state: 'FAILED'};
          batch.samples.push(sample);
          save(report);

          try {
            const input = await sdk.registerInput(document.bytes, inputSchema);
            const task = await sdk.submit({version: 3, id, outputContract: outputSchema, qualityTarget: 'reference',
              nodes: [{id: 'compute', capability, input, parameters, dependsOn: [],
                ...(mode.targetId ? {targetId: mode.targetId} : {})}]},
              {requestId: id, budgetMs: 30000, resultDestination: 'ORIGIN'});
            const result = await task.result();
            Object.assign(sample, {deviceId: result.status.deviceId, targetId: result.status.targetId,
              traceId: result.status.traceId, outputSha256: hash(result.output)});
            if (sample.outputSha256 !== report.documents[documentIndex].expectedSha256) throw Error('RESULT_MISMATCH');
            if (mode.targetId && sample.targetId !== mode.targetId) throw Error('TARGET_MISMATCH');
            sample.state = 'PASS';
          } catch (error) {
            sample.error = /^[A-Z_]+$/.test(error.message) ? error.message : 'EXECUTION_FAILED';
            // Stop starting work after a failure. Preserve unknown delivery for reconciliation.
            next = count;
          } finally {
            // Other workers may still use the registered hash. Release only after the batch.
            sample.durationMs = performance.now() - start;
            save(report);
          }
        }
      }
      await Promise.all(Array.from({length: Math.min(concurrency, count)}, worker));
      batch.durationMs = performance.now() - started;
      batch.samples.sort((a, b) => a.index - b.index);
      if (batch.samples.length !== count || batch.samples.some(s => s.state !== 'PASS')) {
        report.verdict = 'FAILED'; save(report); return report;
      }
      save(report);
    }
  }
  const median = values => {const sorted = values.toSorted((a, b) => a - b);const mid = Math.floor(sorted.length / 2);return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;};
  report.medianBatchMs = Object.fromEntries(modes.map(m => [m.name,
    median(report.batches.filter(b => b.mode === m.name).map(b => b.durationMs))]));
  report.speedup = Math.min(...targets.map(t => report.medianBatchMs[t])) / report.medianBatchMs.TEAM;
  report.teamDevices = [...new Set(report.batches.filter(b => b.mode === 'TEAM').flatMap(b => b.samples.map(s => s.deviceId)))];
  report.verdict = report.teamDevices.length < 2 ? 'SINGLE_DEVICE_SELECTED' : report.speedup > 1 ? 'MEASURED_SPEEDUP' : 'NO_SPEEDUP';
  save(report); return report;
}

async function main() {
  const [configFile, workloadFile, reportFile] = process.argv.slice(2);
  if (!configFile || !workloadFile || !reportFile) throw Error('COMPARISON_ARGUMENTS');
  const config = JSON.parse(fs.readFileSync(configFile)), workload = JSON.parse(fs.readFileSync(workloadFile));
  const {SchedulerSdk} = require('@harmony/scheduler-client');
  const {nodeSdkPort} = require('@harmony/scheduler-client/dist/node');
  const inputs = workload.documents ?? [{inputFile: workload.inputFile, expectedFile: workload.expectedFile}];
  const options = {...workload, documents: inputs.map(d => ({bytes: fs.readFileSync(d.inputFile), expected: fs.readFileSync(d.expectedFile)}))};
  const fd = fs.openSync(reportFile, 'wx', 0o600);
  try {
    const report = await compare(new SchedulerSdk(nodeSdkPort(config.connection)), options, value => {
      const data = Buffer.from(JSON.stringify(value, null, 2) + '\n');
      fs.writeSync(fd, data, 0, data.length, 0); fs.ftruncateSync(fd, data.length); fs.fsyncSync(fd);
    });
    console.log(report.verdict);
    if (report.verdict === 'FAILED') process.exitCode = 1;
  } finally { fs.closeSync(fd); }
}
module.exports = {compare};
if (require.main === module) main().catch(() => {console.error('COMPARISON_FAILED: check configuration, output path and saved report');process.exitCode = 1;});
