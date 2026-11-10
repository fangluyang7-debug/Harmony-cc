const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function harness() {
  const source = fs.readFileSync(path.join(__dirname, '../../apps/harmony/scheduler/src/main/ets/v2/host/NativeAgent.ets'), 'utf8');
  const start = source.indexOf(' private async connect():');
  const end = source.indexOf(' private async message(', start);
  assert.ok(start > 0 && end > start);
  // Run the actual connection method with a platform socket substitute; this is not ArkTS build evidence.
  const js = require('esbuild').transformSync('class Host {' + source.slice(start, end) + '} module.exports=Host;', {loader: 'ts', format: 'cjs'}).code;
  const sockets = [], module = {exports: {}};
  const webSocket = {createWebSocket: () => {
    const socket = {handlers: {}, on(name, callback) {this.handlers[name] = callback;}, close: async () => {}};
    sockets.push(socket); return socket;
  }};
  class HostChange {constructor(apply) {this.apply = apply;}}
  new Function('module', 'webSocket', 'HostChange', 'bindAgentJournalV2', 'helloPayload', js)(module, webSocket, HostChange, j => j, () => ({}));
  const host = new module.exports(), state = {journal: {outbox: []}};
  Object.assign(host, {socket: null, connecting: false, stopped: false, ready: false, sent: new Set(),
    installation: {bootstrap: {domain: 'SIMULATED'}}, peerLinks: {invalidate() {}},
    store: {change: async change => change.apply(state)},
    transport: {json: async () => ({domain: 'SIMULATED', version: 2, coordinatorId: 'coordinator', epoch: 1}), connect: async () => {}},
    enqueue: (s, type) => {const message = {type, messageId: 'hello'}; s.journal.outbox.push(message); return message;}, flush: async () => {}});
  return {host, sockets, state};
}
test('failed native connect without a close event releases the socket and permits retry', async () => {
  const {host, sockets, state} = harness();
  host.transport.connect = async () => {throw Error('TLS_CONNECT_FAILED');};
  await assert.rejects(host.connect(), /TLS_CONNECT_FAILED/);
  assert.equal(host.socket, null); assert.equal(host.connecting, false);
  host.transport.connect = async () => {};
  await host.connect();
  assert.equal(host.socket, sockets[1]);
  assert.equal(state.journal.outbox.length, 1);
});
test('late close, error and message events from an old native socket preserve the replacement', async () => {
  const {host, sockets} = harness();
  await host.connect(); sockets[0].handlers.close(); await host.connect();
  host.ready = true; host.welcomed = true; host.sent.add('new-message');
  sockets[0].handlers.close(); sockets[0].handlers.error(); sockets[0].handlers.message(null, 'invalid');
  assert.equal(host.socket, sockets[1]); assert.equal(host.ready, true); assert.equal(host.welcomed, true);
  assert.equal(host.sent.has('new-message'), true);
});
test('native socket error permits reconnect even when platform close rejects', async () => {
  const {host, sockets} = harness();
  await host.connect(); sockets[0].close = async () => {throw Error('ALREADY_CLOSED');};
  sockets[0].handlers.error();
  await host.connect();
  assert.equal(host.socket, sockets[1]);
});
