const {test} = require('node:test');
const assert = require('node:assert/strict');
const {validateDataHostConfig} = require('../dist/data-host');
test('explicit network settings reject incomplete hosts and invalid ports before opening the agent', () => {
  for (const value of [null, {}, {listenHost: '127.0.0.1'}, {listenHost: 'invalid', advertisedHost: 'host'},
    {listenHost: '127.0.0.1', advertisedHost: 'host', port: '7444'},
    {listenHost: '127.0.0.1', advertisedHost: 'host', port: 65536}]) {
    assert.throws(() => validateDataHostConfig(value), /DATA_HOST_CONFIG_INVALID/);
  }
  assert.doesNotThrow(() => validateDataHostConfig({listenHost: '0.0.0.0', advertisedHost: '192.168.1.20', port: 7444}));
});
