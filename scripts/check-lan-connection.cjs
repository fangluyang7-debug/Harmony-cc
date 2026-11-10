const https = require('node:https');
const os = require('node:os');
const fs = require('node:fs');
const {performance} = require('node:perf_hooks');
const {pinOptions} = require('@harmony/resource-transport');

function interfaces() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, entries]) =>
    entries.filter(e => e.family === 'IPv4' && !e.internal).map(e => ({name, address: e.address, netmask: e.netmask})));
}
function request(endpoint, route, credential) {
  const options = pinOptions(endpoint);
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const req = https.get(new URL(route, endpoint.address), {...options,
      headers: credential ? {Authorization: 'Bearer ' + credential} : {}}, res => {
      const chunks = []; let size = 0;
      res.on('data', data => {size += data.length; if (size > 262144) req.destroy(Error('RESPONSE_TOO_LARGE')); else chunks.push(data);});
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) {reject(Error('HTTP_' + res.statusCode)); return;}
        resolve({bytes: Buffer.concat(chunks), durationMs: performance.now() - start,
          localAddress: req.socket?.localAddress});
      });
    });
    const timer = setTimeout(() => req.destroy(Error('CONNECTION_TIMEOUT')), 5000);
    req.once('close', () => clearTimeout(timer)); req.on('error', reject);
  });
}
async function diagnose(config) {
  const endpoint = config.connection ?? config.invitation;
  if (!endpoint) throw Error('INVITATION_OR_AGENT_CONFIG_REQUIRED');
  const domain = config.connection?.domain ?? config.domain;
  const report = {interfaces: interfaces(), coordinator: endpoint.address, checks: [], peers: [], ready: false};
  async function check(name, run) {
    try {const detail = await run(); report.checks.push({name, state: 'PASS', ...detail}); return true;}
    catch (error) {report.checks.push({name, state: 'FAIL', reason: /^[A-Z0-9_]+$/.test(error.code ?? error.message) ? error.code ?? error.message : 'CONNECTION_FAILED'}); return false;}
  }
  if (!await check('TLS_AND_COORDINATOR_READY', async () => {
    const reply = await request(endpoint, '/v2/health/ready');
    if (JSON.parse(reply.bytes).ready !== true) throw Error('COORDINATOR_NOT_READY');
    return {durationMs: reply.durationMs, localAddress: reply.localAddress};
  })) return report;
  if (!await check('COORDINATOR_DOMAIN', async () => {
    const value = JSON.parse((await request(endpoint, '/v2/identity')).bytes);
    if (value.version !== 2 || value.domain !== domain) throw Error('DOMAIN_MISMATCH');
    return {domain: value.domain, epoch: value.epoch};
  })) return report;
  if (config.connection?.credential) {
    if (!await check('AUTHENTICATED_ENDPOINT_DIRECTORY', async () => {
      const peers = JSON.parse((await request(endpoint, '/v2/data/endpoints', config.connection.credential)).bytes);
      if (!Array.isArray(peers)) throw Error('ENDPOINT_DIRECTORY_INVALID');
      for (const peer of peers) {
        const item = {deviceId: peer.deviceId, address: peer.address, state: 'UNREACHABLE'};
        try {
          const probe = await request(peer, '/v2/direct/probe?bytes=1024');
          if (probe.bytes.length !== 1024) throw Error('PROBE_INVALID');
          Object.assign(item, {state: 'READ_PROBE_PASS', durationMs: probe.durationMs});
        } catch { /* Peer failure permits coordinator relay; the host performs authoritative probes. */ }
        report.peers.push(item);
      }
      return {count: peers.length};
    })) return report;
  } else report.checks.push({name: 'DEVICE_CREDENTIAL', state: 'NOT_PAIRED'});
  report.ready = true;
  return report;
}
module.exports = {diagnose, interfaces};
if (require.main === module) (async () => {
  const file = process.argv[2];
  if (!file) {console.log(JSON.stringify({interfaces: interfaces(), usage: 'node scripts/check-lan-connection.cjs <invitation.json or agent.json>'}, null, 2)); return;}
  const report = await diagnose(JSON.parse(fs.readFileSync(file)));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 1;
})().catch(() => {console.error('NETWORK_CHECK_FAILED: verify input configuration');process.exitCode = 1;});
