const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
test('console download includes the native bootstrap contribution and preserves PC pairing fields', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../apps/team-space-web/app.js'), 'utf8');
  const start = source.indexOf('function addDevice()');
  const end = source.indexOf('async function submitJob(', start);
  let submit, downloaded;
  const buttons = {'#download-invite': {}, '#download-policy': {}};
  const registered = {holderInstanceId: 'fixture-holder', domain: 'SIMULATED', invitation: {code: 'fixture'},
    contribution: {ownerMode: 'dedicated', maxCpuThreads: 2, maxMemoryBytes: 1073741824, reserveMemoryBytes: 1073741824}};
  const context = {spaceId: 'fixture', field: () => '', esc: s => s,
    modal: (_title, _description, _html, _action, callback) => {if (callback) submit = callback;},
    api: async () => registered, document: {querySelector: id => buttons[id]}, refresh: async () => {},
    download: (name, value) => {downloaded = {name, value};}};
  vm.runInNewContext(source.slice(start, end) + '\naddDevice();', context);
  await submit({name: 'Harmony', threads: '2', memory: '1', vram: '0', mode: 'dedicated'});
  buttons['#download-invite'].onclick();
  assert.equal(downloaded.name, 'invitation.json');
  assert.deepEqual(JSON.parse(JSON.stringify(downloaded.value)), registered);
});
