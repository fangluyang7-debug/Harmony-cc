// Benchmark-only instrumentation. Never imported by production applications.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { AsyncLocalStorage } = require('node:async_hooks');
const { fork, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => performance.now();

async function localServer(dir) {
  const { loadConfig } = require('../../services/coordinator/dist/config');
  const { createCoordinator } = require('../../services/coordinator/dist/app');
  const config = loadConfig({ COORDINATOR_DATA_DIR: dir, COORDINATOR_PORT: '0', COORDINATOR_DOMAIN: 'REAL' });
  execFileSync(process.execPath, ['scripts/migrate.cjs'], {
    cwd: path.join(root, 'services/coordinator'),
    env: { ...process.env, COORDINATOR_DATA_DIR: dir }, stdio: 'pipe', windowsHide: true
  });
  const server = await createCoordinator(config, async () => {}, { cpuHost: true });
  await server.app.listen(0, '127.0.0.1'); await server.restore();
  config.publicUrl = 'https://localhost:' + server.app.getHttpServer().address().port;
  process.send({ address: config.publicUrl, ca: server.identity.cert });
  process.once('message', async () => { await server.close(); process.disconnect(); });
}

function client(address, ca) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 4, ...(ca ? { ca } : {}) });
  let cookie = '';
  async function request(route, body, options = {}) {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const started = now();
    return new Promise((resolve, reject) => {
      const req = https.request(new URL(route, address), {
        agent: options.cold ? false : agent, ...(ca ? { ca } : {}),
        method: bytes ? 'POST' : 'GET',
        headers: { Cookie: cookie, ...options.headers, ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}) }
      }, res => {
        const chunks = []; const firstByteMs = now() - started;
        if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0];
        res.on('data', c => chunks.push(c)); res.on('error', reject);
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks), data = JSON.parse(raw);
            if (res.statusCode < 200 || res.statusCode >= 300) throw Error(data.error || data.message || 'HTTP_' + res.statusCode);
            resolve({ data, ms: now() - started, firstByteMs, bytes: raw.length, reusedSocket: req.reusedSocket,
              ...(res.headers['x-railway-edge'] ? { edge: res.headers['x-railway-edge'] } : {}),
              ...(res.headers['x-railway-upstream-zone'] ? { upstreamZone: res.headers['x-railway-upstream-zone'] } : {}) });
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(20000, () => req.destroy(Error('REQUEST_TIMEOUT')));
      req.on('error', reject); req.end(bytes);
    });
  }
  return { request, api: async (route, body) => (await request('/v2/spaces' + route, body)).data, close: () => agent.destroy() };
}

async function until(check, timeout = 180000, interval = 250) {
  const deadline = now() + timeout;
  while (now() < deadline) { const result = await check(); if (result) return result; await sleep(interval); }
  throw Error('WAIT_TIMEOUT');
}

function stats(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  const q = p => a.length ? Math.round(a[Math.max(0, Math.ceil(a.length * p) - 1)] * 100) / 100 : null;
  return { n: a.length, min: q(0), median: q(.5), p95: q(.95), max: q(1) };
}

async function main() {
  const address = process.argv[2];
  if (!address || new URL(address).protocol !== 'https:') throw Error('Supply the Harmony HTTPS URL');
  const dir = fs.mkdtempSync(path.join(root, '.test/latency-'));
  const report = {
    startedAt: new Date().toISOString(), baseline: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    environment: { node: process.version, platform: os.platform(), cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 2 ** 30), cloud: address },
    method: { rounds: 3, order: ['local', 'cloud', 'cloud', 'local', 'local', 'cloud'], pollIntervalMs: 100, concurrency: 1, local: 'Loopback TLS, independent coordinator process, same physical PC', domain: 'REAL', productionChanges: false },
    setup: [], samples: [], errors: [], cleanup: []
  };
  const save = () => fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(report, null, 2));
  console.log('Output directory: ' + dir);
  const localLog = fs.openSync(path.join(dir, 'local-server.log'), 'a');
  const child = fork(__filename, ['--local-server', path.join(dir, 'coordinator')], { windowsHide: true, stdio: ['ignore', localLog, localLog, 'ipc'] });
  const local = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('LOCAL_START_TIMEOUT')), 60000);
    child.once('message', value => { clearTimeout(timer); resolve(value); });
    child.once('exit', code => { clearTimeout(timer); reject(Error('LOCAL_EXIT_' + code)); });
  });
  const contexts = [];
  const engine = require('../../services/pc-agent/dist/cpu-engine');
  const originalExecute = engine.executeCpu;
  const taskContext = new AsyncLocalStorage();
  engine.executeCpu = async (...args) => {
    const t = now(); const result = await originalExecute(...args);
    const activeTask = taskContext.getStore();
    if (activeTask) { activeTask.engineWallMs = now() - t; activeTask.algorithmMs = result.durationMs; }
    return result;
  };
  try {
    for (const [name, endpoint] of [['local', local], ['cloud', { address }]]) {
      const c = { name, ...endpoint, client: client(endpoint.address, endpoint.ca), times: new Map() }; contexts.push(c);
      if (name === 'cloud') {
        const probe = await c.client.request('/v2/health/ready', undefined, { headers: { 'X-Railway-Debug': 'true' } });
        report.environment.railwayRoute = { edge: probe.edge, upstreamZone: probe.upstreamZone };
      }
      const t = now(), account = 'latency-' + crypto.randomUUID(), password = crypto.randomBytes(24).toString('base64url');
      await c.client.api('/register', { account, password, name: '时延实验' });
      // Credentials stay exclusively in ignored .test, never in the sanitized report.
      const hostDir = path.join(dir, name); fs.mkdirSync(hostDir);
      fs.writeFileSync(path.join(hostDir, 'account.json'), JSON.stringify({ account, password }), { mode: 0o600 });
      c.spaceId = (await c.client.api('/', { name: '时延对照实验 ' + new Date().toISOString() })).id;
      c.settings = { ownerMode: 'dedicated', maxCpuThreads: 1, maxMemoryBytes: 268435456, reserveMemoryBytes: 134217728 };
      const invitation = await c.client.api('/' + c.spaceId + '/devices', { name: '临时时延测试代理', settings: c.settings });
      const file = path.join(hostDir, 'invitation.json'), install = path.join(hostDir, 'agent');
      fs.writeFileSync(file, JSON.stringify(invitation), { mode: 0o600 });
      const pairStart = now();
      execFileSync(process.execPath, [path.join(root, 'services/pc-agent/dist/pairing-main.js'), file, install], { windowsHide: true, timeout: 60000, stdio: 'pipe' });
      const pairMs = now() - pairStart;
      const config = JSON.parse(fs.readFileSync(path.join(install, 'agent.json'))); c.connection = config.connection;
      const { CpuHost } = require('../../services/pc-agent/dist/host');
      c.host = await CpuHost.open({ ...config, contribution: structuredClone(c.settings) }, error => {
        report.errors.push({ env: name, at: new Date().toISOString(), code: String(error.message).slice(0, 150) });
      });
      const live = c.host.agent.client.live, dispatch = live.dispatch;
      live.dispatch = m => { const task = c.times.get(JSON.parse(m.payload).task.attemptId); if (task && task.dispatchMs === undefined) task.dispatchMs = now() - task.started; dispatch(m); };
      const ports = c.host.agent.runtime.ports;
      const runtime = c.host.agent.runtime, run = runtime.run.bind(runtime);
      runtime.run = (offer, ...args) => taskContext.run(c.times.get(offer.task.attemptId), () => run(offer, ...args));
      for (const key of ['authorize', 'read', 'publish']) {
        const original = ports[key];
        ports[key] = async (...args) => { const start = now(); try { return await original(...args); } finally { const activeTask = taskContext.getStore(); if (activeTask) activeTask[key + 'Ms'] = now() - start; } };
      }
      const readyStart = now(); c.host.start();
      await until(async () => {
        const d = await c.client.api('/' + c.spaceId);
        return d.devices[0].capabilities.length === 2 && d.devices[0].capabilities.every(x => x.available && x.state === 'ACTIVE');
      });
      report.setup.push({ env: name, totalMs: now() - t, pairMs, qualifyMs: now() - readyStart }); save();
      console.log(name + ': paired and qualified');
    }

    const cases = [
      { id: 'text-tiny', capability: 'text.count.v1', input: { text: 'Hello team' }, verify: o => assert.deepEqual(o, { characters: 10, words: 2, lines: 1 }) },
      { id: 'text-256k', capability: 'text.count.v1', input: { text: 'Harmony '.repeat(32768) }, verify: o => assert.deepEqual(o, { characters: 262144, words: 32768, lines: 1 }) },
      { id: 'vector-4096x8', capability: 'vector.normalize.v1', input: { dimension: 8, rows: Array.from({ length: 4096 }, () => [1, 2, 3, 4, 5, 6, 7, 8]) }, verify: o => { assert.equal(o.rows.length, 4096); assert.equal(o.dimension, 8); assert.ok(o.rows.every(r => r.every((v, i) => Math.abs(v - (i + 1) / Math.sqrt(204)) < 1e-12))); assert.ok(o.norms.every(n => Math.abs(n - Math.sqrt(204)) < 1e-12)); } }
    ];
    async function record(c, scenario, round, iteration, fn) {
      const s = { env: c.name, scenario, round, iteration, at: new Date().toISOString(), ok: false };
      report.samples.push(s); const t = now();
      try { Object.assign(s, await fn()); s.ok = true; } catch (error) { s.error = error.message; s.elapsedMs = now() - t; console.log(c.name + ' ' + scenario + ' FAILED: ' + error.message); }
      save(); return s;
    }
    async function job(c, test) {
      const readinessStarted = now();
      await until(async () => {
        const snapshot = await c.client.api('/' + c.spaceId);
        return snapshot.devices[0].capabilities.some(x => x.capability === test.capability && x.available && x.state === 'ACTIVE');
      }, 30000, 250);
      const readinessWaitMs = now() - readinessStarted;
      const id = crypto.randomUUID(), task = { started: now() }; c.times.set(id, task);
      try {
        const submitted = await c.client.request('/v2/spaces/' + c.spaceId + '/jobs', { requestId: id, capability: test.capability, input: test.input });
        const submitMs = now() - task.started; let polls = 0;
        const result = await until(async () => {
          const r = await c.client.request('/v2/spaces/' + c.spaceId + '/jobs/' + id); polls++;
          if (['FAILED', 'REJECTED', 'CANCELLED_SETTLED'].includes(r.data.state)) throw Error('TASK_' + r.data.state);
          return r.data.output ? r : null;
        }, 45000, 100);
        const e2eMs = now() - task.started; test.verify(result.data.output);
        const { started, ...timing } = task;
        return { ...timing, readinessWaitMs, submitMs, e2eMs, includingReadinessMs: readinessWaitMs + e2eMs, polls, inputBytes: Buffer.byteLength(JSON.stringify(test.input)), outputBytes: Buffer.byteLength(JSON.stringify(result.data.output)), resultFetchMs: result.ms };
      } finally { c.times.delete(id); }
    }
    // Discard one warm-up task per scenario per topology, but retain its outcome explicitly.
    report.warmups = [];
    for (const c of contexts) for (const test of cases) { try { report.warmups.push({ env: c.name, scenario: test.id, ok: true, ...(await job(c, test)) }); } catch (e) { report.warmups.push({ env: c.name, scenario: test.id, ok: false, error: e.message }); } }
    for (let block = 0; block < report.method.order.length; block++) {
      const c = contexts.find(x => x.name === report.method.order[block]), round = Math.floor(block / 2) + 1;
      console.log('Block ' + (block + 1) + '/6: ' + c.name);
      for (let i = 0; i < 5; i++) await record(c, 'https-new-connection', round, i, () => c.client.request('/v2/health/ready', undefined, { cold: true }).then(({ data, ...r }) => r));
      for (let i = 0; i < 20; i++) await record(c, 'https-keepalive', round, i, () => c.client.request('/v2/health/ready').then(({ data, ...r }) => r));
      for (let i = 0; i < 10; i++) await record(c, 'dashboard', round, i, () => c.client.request('/v2/spaces/' + c.spaceId).then(({ data, ...r }) => r));
      for (let i = 0; i < 20; i++) await record(c, 'websocket-ping', round, i, () => new Promise((resolve, reject) => {
        const socket = c.host.agent.client.socket, payload = crypto.randomBytes(8), t = now();
        if (!socket || socket.readyState !== 1) return reject(Error('SOCKET_UNAVAILABLE'));
        const timer = setTimeout(() => { socket.off('pong', pong); reject(Error('PONG_TIMEOUT')); }, 10000);
        function pong(bytes) { if (bytes.equals(payload)) { clearTimeout(timer); socket.off('pong', pong); resolve({ ms: now() - t }); } }
        socket.on('pong', pong); socket.ping(payload);
      }));
      for (let i = 0; i < 5; i++) for (const test of cases) await record(c, test.id, round, i, () => job(c, test));
      await record(c, 'pause-applied', round, 0, async () => {
        const t = now(); const snapshot = await c.client.api('/' + c.spaceId), deviceId = snapshot.devices[0].id;
        const start = now(); await c.client.api('/' + c.spaceId + '/devices/' + deviceId, { settings: { ...c.settings, ownerMode: 'paused' } });
        const acceptedMs = now() - start;
        await until(() => c.host.owner === 'ACTIVE', 15000, 20);
        const appliedMs = now() - start;
        await c.client.api('/' + c.spaceId + '/devices/' + deviceId, { settings: c.settings });
        await until(async () => { const d = await c.client.api('/' + c.spaceId); return c.host.owner === 'IDLE' && d.devices[0].capabilities.every(x => x.available); }, 30000, 250);
        return { acceptedMs, appliedMs, elapsedMs: now() - t };
      });
    }
  } finally {
    for (const c of contexts) {
      try { await c.host?.close(); report.cleanup.push({ env: c.name, agentStopped: true }); } catch (e) { report.cleanup.push({ env: c.name, stopError: e.message }); }
      if (c.connection) try { await c.client.request('/v2/credentials/revoke', {}, { headers: { Authorization: 'Bearer ' + c.connection.credential } }); report.cleanup.push({ env: c.name, credentialRevoked: true }); } catch (e) { report.cleanup.push({ env: c.name, revokeError: e.message }); }
      await c.client.api('/logout', {}).catch(() => {}); c.client.close();
    }
    engine.executeCpu = originalExecute;
    if (child.connected) { const ended = new Promise(r => child.once('exit', r)); child.send('stop'); const timer = setTimeout(() => child.kill(), 10000); await ended; clearTimeout(timer); }
    fs.closeSync(localLog);
    report.finishedAt = new Date().toISOString();
    report.summary = [];
    for (const env of ['local', 'cloud']) for (const scenario of [...new Set(report.samples.map(s => s.scenario))]) {
      const rows = report.samples.filter(s => s.env === env && s.scenario === scenario), passed = rows.filter(s => s.ok);
      const summary = { env, scenario, total: rows.length, failed: rows.length - passed.length };
      for (const metric of ['ms', 'readinessWaitMs', 'includingReadinessMs', 'submitMs', 'dispatchMs', 'authorizeMs', 'readMs', 'engineWallMs', 'algorithmMs', 'publishMs', 'e2eMs', 'acceptedMs', 'appliedMs']) if (passed.some(s => Number.isFinite(s[metric]))) summary[metric] = stats(passed.map(s => s[metric]));
      report.summary.push(summary);
    }
    save(); console.log('Benchmark complete: ' + path.join(dir, 'results.json'));
  }
}
if (process.argv[2] === '--local-server') localServer(process.argv[3]).catch(e => { console.error(e); process.exitCode = 1; });
else main().catch(e => { console.error(e); process.exitCode = 1; });
