const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {fork, execFile} = require('node:child_process');
const {runtime} = require('./helpers.cjs');
const {SchedulerSdk} = require('@harmony/scheduler-client');
const {nodeSdkPort} = require('@harmony/scheduler-client/dist/node');
const {diagnose, interfaces} = require('../../../scripts/check-lan-connection.cjs');
const command = (file, args) => new Promise((resolve, reject) => execFile(process.execPath, [file, ...args],
  {windowsHide: true, timeout: 30000}, (error) => error ? reject(Error('PAIRING_COMMAND_FAILED')) : resolve()));

test('three independent hosts pair and exchange verified SDK results using a selected LAN address', async t => {
  const address = process.env.HARMONY_TEST_LAN_ADDRESS;
  if (!address) {t.skip('set HARMONY_TEST_LAN_ADDRESS to a local LAN IPv4'); return;}
  assert.ok(interfaces().some(i => i.address === address), 'selected address must belong to this host');
  const r = await runtime({cpuHost: true}, {COORDINATOR_HOST: '0.0.0.0', COORDINATOR_CERTIFICATE_HOST: address});
  const children = [], configs = [], errors = [];
  const group = randomUUID(), capacity = [{resourcePoolId: 'cpu', amount: 1}, {resourcePoolId: 'ram', amount: 268435456}];
  try {
    for (let i = 0; i < 3; i++) {
      const device = randomUUID(), holder = randomUUID();
      const invitation = await r.auth.invite(group, randomUUID(), device, r.url);
      await r.allotments.confirmDevice(device, capacity, [{groupId: group, holderInstanceId: holder, appInstanceId: null}]);
      const bootstrap = {invitation, holderInstanceId: holder, domain: 'SIMULATED',
        contribution: {ownerMode: 'dedicated', maxCpuThreads: 1, maxMemoryBytes: 268435456, reserveMemoryBytes: 0}};
      const check = await diagnose(bootstrap); assert.equal(check.ready, true, JSON.stringify(check));
      const invitationFile = path.join(r.config.dataDir, `invitation-${i}.json`);
      const policy = path.join(r.config.dataDir, `contribution-${i}.json`);
      const installation = path.join(r.config.dataDir, `host-${i}`);
      fs.writeFileSync(invitationFile, JSON.stringify(bootstrap));
      fs.writeFileSync(policy, JSON.stringify(bootstrap.contribution));
      await command(path.resolve('../pc-agent/dist/pairing-main.js'), [invitationFile, installation]);
      const configFile = path.join(installation, 'agent.json');
      const networkFile = path.join(r.config.dataDir, `network-${i}.json`);
      fs.writeFileSync(networkFile, JSON.stringify(i > 0 ? false : {listenHost: address, advertisedHost: address, port: 0}));
      const config = JSON.parse(fs.readFileSync(configFile));
      // Model the current native agents' outbound-only data connectivity.
      if (i > 0) config.dataEndpoint = false;
      fs.writeFileSync(configFile, JSON.stringify(config));
      configs.push(config);
      const child = fork(path.resolve('../pc-agent/dist/host-main.js'), [configFile, policy, networkFile],
        {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
      child.stderr.on('data', bytes => errors.push(bytes.toString())); children.push(child);
    }
    const until = Date.now() + 180000;
    let candidates = [];
    while (Date.now() < until) {
      try {candidates = (await r.snapshots.build(group)).snapshot.candidates.filter(c => c.capability === 'text.count.v1');}
      catch (error) {if (error.message !== 'GROUP_UNKNOWN') throw error;}
      if (configs.every(config => candidates.some(c => c.holderInstanceId === config.identity.holderInstanceId))) break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.equal(candidates.length, 3, JSON.stringify(errors));
    assert.equal(new Set(children.map(c => c.pid)).size, 3);
    const owner = await r.auth.authenticate(configs[0].connection.credential);
    const invite = await r.apps.register(owner, {label: 'LAN verification', allowedContracts: ['text.count.v1'],
      maxConcurrent: 1, resources: capacity, offlineBase: [], onlineExtra: []}, r.url);
    const app = await r.apps.exchange({registrationId: invite.registrationId, code: invite.code});
    const sdk = new SchedulerSdk(nodeSdkPort({...configs[0].connection, credential: app.credential}));
    for (const candidate of candidates) {
      const id = randomUUID(), input = await sdk.registerInput(Buffer.from('{"text":"LAN hello"}'), 'text.input');
      const task = await sdk.submit({version: 3, id, outputContract: 'text.counts', qualityTarget: 'reference',
        nodes: [{id: 'count', capability: 'text.count.v1', input, parameters: '{}', dependsOn: [], targetId: candidate.targetId}]},
        {requestId: id, budgetMs: 30000, resultDestination: 'ORIGIN'});
      const result = await task.result();
      assert.equal(result.status.deviceId, candidate.deviceId);
      assert.deepEqual(JSON.parse(Buffer.from(result.output)), {characters: 9, words: 2, lines: 1});
      assert.equal((await r.db.receipt.findUniqueOrThrow({where: {id}})).committed, true);
    }
    const network = await diagnose(configs[0]);
    assert.equal(network.ready, true, JSON.stringify(network));
    assert.equal(network.peers.length, 1);
    assert.ok(network.peers.every(p => p.state === 'READ_PROBE_PASS' && new URL(p.address).hostname === address));
    const wrong = {...configs[0], connection: {...configs[0].connection, fingerprint: '0'.repeat(64)}};
    assert.equal((await diagnose(wrong)).ready, false);
  } finally {
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null) {resolve(); return;}
      const timer = setTimeout(() => child.kill(), 5000);
      child.once('exit', () => {clearTimeout(timer); resolve();}); child.send('stop');
    })));
    await r.close();
  }
});
