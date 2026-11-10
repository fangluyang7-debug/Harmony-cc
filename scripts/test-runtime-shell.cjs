// Run against an extracted 02-Device-Agent-Windows-x64 package.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const root = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw Error('Supply the extracted Windows device package directory');
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'resources/app/package.json')));
const role = metadata.runtimeRole || 'agent';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidiao-shell-test-'));
const report = path.join(temporary, 'result.json');
const harness = path.join(temporary, 'main.cjs');
fs.writeFileSync(harness, `
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
app.setPath('userData', ${JSON.stringify(path.join(temporary, 'profile'))});
fs.writeFileSync(${JSON.stringify(path.join(temporary, 'boot.txt'))}, 'harness started');
let done = false;
const timer = setTimeout(() => { console.error('Window readiness timed out'); app.exit(2); }, 25000);
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      const result = await window.webContents.executeJavaScript(
        "(async () => { const state = await api('/state'); if (document.body.dataset.page === 'center') return {title: document.title, page: 'center', power: !!document.getElementById('power'), state: state.state, nodeAccess: typeof require}; for (let i = 0; i < 100 && document.getElementById('import').disabled; i++) await new Promise(r => setTimeout(r, 100)); document.getElementById('import').click(); return {title: document.title, page: document.body.dataset.page, pairing: document.getElementById('pair-dialog').open, state: state.state, nodeAccess: typeof require}; })()"
      );
      if (result.page !== ${JSON.stringify(role)} || (${JSON.stringify(role)} === 'agent' ? !result.pairing : !result.power) || result.nodeAccess !== 'undefined' || result.state !== 'STOPPED') throw Error(JSON.stringify(result));
      window.setSize(800, 600);
      const image = await window.webContents.capturePage();
      fs.writeFileSync(${JSON.stringify(path.join(temporary, 'window.png'))}, image.toPNG());
      fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify(result));
      clearTimeout(timer);
      done = true;
      window.close();
    } catch (error) { console.error(error); app.exit(3); }
  });
});
require(${JSON.stringify(path.join(root, 'apps/runtime-desktop/electron-main.cjs'))});
`);
const manifestPath = path.join(root, 'resources/app/package.json');
const originalManifest = fs.readFileSync(manifestPath);
const manifest = JSON.parse(originalManifest);
manifest.main = 'shell-smoke.cjs';
let result;
try {
fs.writeFileSync(manifestPath, JSON.stringify(manifest));
fs.copyFileSync(harness, path.join(root, 'resources/app/shell-smoke.cjs'));
result = spawnSync(path.join(root, role === 'center' ? 'ZhiDiaoCenter.exe' : 'ZhiDiaoHongShu.exe'), [], {
  windowsHide: true, encoding: 'utf8', timeout: 45000,
  env: {...process.env, ELECTRON_ENABLE_LOGGING: '1'}
});
} finally {
  fs.writeFileSync(manifestPath, originalManifest);
  fs.unlinkSync(path.join(root, 'resources/app/shell-smoke.cjs'));
}
if (result.error || result.status !== 0 || !fs.existsSync(report)) {
  console.error(result.error || 'Window test failed');
  console.error(result.stderr || 'No diagnostic output');
  process.exit(1);
}
console.log(fs.readFileSync(report, 'utf8'));
console.log(role + ' window rendered, local API authenticated, application exited. Evidence: ' + temporary);
