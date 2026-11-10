const {app,BrowserWindow,ipcMain,session,Menu}=require('electron'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{X509Certificate}=require('node:crypto');
const {HostManager}=require('./host-manager.cjs');
let window,manager,connection=null,quitting=false;
if(process.env.HARMONY_DESKTOP_DATA)app.setPath('userData',path.resolve(process.env.HARMONY_DESKTOP_DATA));
if(!app.requestSingleInstanceLock())app.quit();
else{
 app.on('second-instance',()=>{window?.show();window?.focus();});
 app.whenReady().then(async()=>{
  const dir=app.getPath('userData'),connectionFile=path.join(dir,'console.json');
  try{connection=JSON.parse(fs.readFileSync(connectionFile));}catch{}
  manager=new HostManager(path.join(dir,'devices'),path.join(__dirname,'runtime'));
  const launcher=path.join(__dirname,'launcher.html');
  function allowed(event,local=false){const u=event.senderFrame?.url??'';if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||!(local&&u.startsWith('file:')||connection&&new URL(u).origin===connection.address))throw Error('CONSOLE_DEVICE_SCOPE');}
  session.defaultSession.setCertificateVerifyProc((request,callback)=>{
   let matches=false;try{matches=connection&&request.hostname===new URL(connection.address).hostname&&new X509Certificate(request.certificate.data).fingerprint256.replaceAll(':','').toLowerCase()===connection.fingerprint;}catch{}
   callback(matches?0:-3);
  });
  ipcMain.handle('console:connect',async(event,value)=>{
   allowed(event,true);const {parseJoinKey}=await import('./join-key.mjs'),key=parseJoinKey(value,connection?.address);
   connection={address:key.address,fingerprint:key.fingerprint||(key.address===connection?.address?connection.fingerprint:'')};fs.writeFileSync(connectionFile,JSON.stringify(connection));
   await window.loadURL(key.address+'/#join='+encodeURIComponent(key.code));return true;
  });
  ipcMain.handle('device:info',event=>{allowed(event,true);return JSON.stringify({name:os.hostname(),platform:'windows',...manager.status()});});
  ipcMain.handle('console:discover',event=>{allowed(event,true);return require('./discovery.cjs').discoverCenters();});
  ipcMain.handle('device:join',async(event,encoded)=>{allowed(event);if(typeof encoded!=='string'||encoded.length>32768)throw Error('INVITATION_INVALID');const d=JSON.parse(encoded);if(new URL(d.invitation.address).origin!==connection.address||connection.fingerprint&&d.invitation.fingerprint!==connection.fingerprint)throw Error('CONSOLE_DEVICE_SCOPE');return manager.join(encoded);});
  ipcMain.handle('device:restart',async event=>{allowed(event,true);await manager.start();return JSON.stringify(manager.status());});
  window=new BrowserWindow({width:1440,height:960,minWidth:900,minHeight:650,title:'Harmony 协作空间',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Harmony',submenu:[{label:'输入接入密钥',click:()=>window.loadFile(launcher)},{label:'协作空间',click:()=>connection?window.loadURL(connection.address):window.loadFile(launcher)},{label:'调度盘',click:()=>connection&&window.loadURL(connection.address+'/dispatch.html?space='+encodeURIComponent(manager.status().groupId))},{label:'重新连接本机',click:()=>manager.start().catch(()=>{})},{type:'separator'},{role:'quit',label:'退出应用并停止贡献'}]}]));
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(!connection||new URL(url).origin!==connection.address)event.preventDefault();});
  session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  try{await (connection?window.loadURL(connection.address):window.loadFile(launcher));}
  catch{await window.loadFile(launcher);}
  await manager.start().catch(e=>{manager.error=e.message;});
 });
 app.on('window-all-closed',()=>app.quit());
 app.on('before-quit',event=>{if(!quitting&&manager?.child){event.preventDefault();quitting=true;manager.stop().then(()=>app.quit()).catch(()=>{quitting=false;window?.show();});}});
}
