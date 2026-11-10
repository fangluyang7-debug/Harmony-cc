const {app, BrowserWindow, dialog, Menu} = require('electron');
const path = require('node:path');
const {fork, spawn} = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const role = require(path.join(root, 'resources/app/package.json')).runtimeRole || 'agent';
if (!['agent', 'center'].includes(role)) throw Error('DESKTOP_ROLE_INVALID');
let child, window, closing = false;
app.setName(role === 'center' ? '智调鸿枢-协调中心' : '智调鸿枢-设备节点');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    child = fork(path.join(root, 'apps/runtime-desktop/electron-runtime.cjs'), [role], {
      execPath: path.join(root, 'runtime/node.exe'), cwd: root, windowsHide: true,
      env: {...process.env, PATH: path.join(root, 'runtime/openssl') + path.delimiter + process.env.PATH},
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    let errors = '';
    child.stderr.on('data', data => { errors = (errors + data).slice(-3000); });
    child.on('error', error => { dialog.showErrorBox('启动失败', error.message); app.exit(1); });
    child.on('exit', code => {
      if (!closing) dialog.showErrorBox('本地服务已退出', errors || '请重新打开程序。');
      app.exit(closing ? 0 : code || 1);
    });
    child.on('message', message => {
      if (message.type !== 'ready') return;
      const origin = new URL(message.url).origin;
      window = new BrowserWindow({width: 1180, height: 820, minWidth: 760, minHeight: 560,
        title: role === 'center' ? '智调鸿枢 · 协调中心' : '智调鸿枢 · 设备调度件', backgroundColor: '#0b0e14',
        webPreferences: {nodeIntegration: false, contextIsolation: true, sandbox: true}});
      window.webContents.setWindowOpenHandler(({url}) => {const u=new URL(url);return u.origin==='http://127.0.0.1:'+String(process.env.HARMONY_DISPLAY_PORT||7460)&&u.pathname==='/'?{action:'allow',overrideBrowserWindowOptions:{width:1440,height:960,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}}}:{action:'deny'};});
      window.webContents.on('will-navigate', (event, url) => {
        if (new URL(url).origin !== origin) event.preventDefault();
      });
      window.on('close', event => { event.preventDefault(); app.quit(); });
      void window.loadURL(message.url);
    });
  });
  app.on('before-quit', event => {
    if (!child || child.exitCode !== null) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    window?.hide();
    child.send({type: 'shutdown'});
    // A stuck worker must not outlive an explicitly closed application.
    setTimeout(() => {
      if (child.exitCode === null) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true});
    }, 15000).unref();
  });
}
