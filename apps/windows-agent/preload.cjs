const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('harmonyDevice',{
 available:()=>true,
 info:()=>ipcRenderer.invoke('device:info'),
 discoverCenters:()=>ipcRenderer.invoke('console:discover'),
 joinDevice:encoded=>ipcRenderer.invoke('device:join',encoded),
 connectInvite:value=>ipcRenderer.invoke('console:connect',value),
 restart:()=>ipcRenderer.invoke('device:restart')
});
