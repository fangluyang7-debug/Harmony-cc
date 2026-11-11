// Integration check for unpacked release directories, using a disposable coordinator and identity.
// Never attach the test node to the user's actual collaboration space.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {if (await check()) return; await pause(250);}
  throw Error('PACKAGE_CHECK_TIMEOUT');
}
async function main() {
  const centerRoot = path.resolve(process.argv[2]), agentRoot = path.resolve(process.argv[3]);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('HARMONY_PHOTO_') || key.startsWith('PC_IMAGE_') || key === 'HARMONY_COORDINATOR_DATA_DIR') delete process.env[key];
  }
  process.env.COORDINATOR_OPENSSL = path.join(centerRoot, 'runtime/openssl/openssl.exe');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-package-check-'));
  const centerModule = require(path.join(centerRoot, 'scripts/runtime-desktop.cjs'));
  const agentModule = require(path.join(agentRoot, 'scripts/runtime-desktop.cjs'));
  const address = centerModule.addresses()[0]?.address;
  assert.ok(address, 'LAN adapter required');
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '0.0.0.0', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const desktop = await centerModule.main({openBrowser: false, role: 'center', display: false, bindingFile: path.join(data, 'center-binding.json')});
  const center = desktop.control;
  center.dataRoot = data;
  const device = new agentModule.RuntimeControl({bindingFile: path.join(data, 'device-binding.json')});
  try {
    center.startCenter({address, port});
    await until(() => ['RUNNING', 'FAILED'].includes(center.state));
    assert.equal(center.state, 'RUNNING', center.logs.join('\n'));
    const url = new URL(desktop.url), origin = url.origin;
    const session = await fetch(origin + '/console/session', {method: 'POST', headers: {Origin: origin, 'X-Runtime-Token': url.hash.slice(1)}, body: '{}'});
    assert.equal(session.status, 200);
    const cookie = session.headers.get('set-cookie').split(';')[0];
    async function api(route, body) {
      const response = await fetch(origin + route, {method: body ? 'POST' : 'GET', headers: {Cookie: cookie, Origin: origin, 'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
      assert.equal(response.status, 200, route);
      return response.json();
    }
    const account = await api('/v2/spaces/me'), group = account.spaces[0].id;
    const invite = await api('/v2/spaces/' + group + '/devices', {name: 'Isolated package check', settings: {
      ownerMode: 'dedicated', capacityMode: 'auto', maxCpuThreads: 2, maxMemoryBytes: 1073741824, reserveMemoryBytes: 1073741824}});
    assert.match(invite.pairingCode, /^\d{6}$/);
    const trust = await agentModule.pairingCertificate(center.url);
    assert.equal(trust.fingerprint, invite.invitation.fingerprint);
    const paired = await device.pair({directory: path.join(data, 'device'), address: center.url,
      fingerprint: trust.fingerprint, invitation: invite.pairingCode});
    device.startAgent({directory: paired.directory});
    await until(() => ['RUNNING', 'FAILED'].includes(device.state));
    assert.equal(device.state, 'RUNNING', device.logs.join('\n'));
    let snapshot;
    await until(async () => {
      snapshot = await api('/v2/spaces/' + group);
      return snapshot.devices.some(d => d.online && d.capabilities.some(c => c.capability === 'photo.enhance.v1' && c.available));
    }, 180000);
    const online = snapshot.devices.find(d => d.online);
    console.log(JSON.stringify({kind: 'ISOLATED_PACKAGE_INTEGRATION', shortCodePairing: true,
      online: online.online, photoCapabilities: online.capabilities.filter(c => c.capability.startsWith('photo.')),
      cpuThreads: online.settings.maxCpuThreads, capacityMode: online.settings.capacityMode,
      productionSpaceChanged: false, gpuHardwareVerified: false}, null, 2));
  } finally {
    device.stop(); await until(() => !device.child, 30000).catch(() => {});
    center.stop(); await until(() => !center.child, 30000).catch(() => {});
    await new Promise(resolve => desktop.server.close(resolve));
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
