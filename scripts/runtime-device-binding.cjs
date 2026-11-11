const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
// One installation identity and one active directory across all space-scoped ledgers.
class DeviceBinding {
 constructor(file){this.file=file;fs.mkdirSync(path.dirname(file),{recursive:true});try{this.data=JSON.parse(fs.readFileSync(file));}catch(e){if(e.code!=='ENOENT')throw e;this.data={installationId:randomUUID(),active:null,known:[]};this.save();}}
 save(){fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.data));fs.renameSync(this.file+'.tmp',this.file);}
 context(){return {installationId:this.data.installationId,deviceId:this.data.active?.deviceId,knownDeviceIds:this.data.known.map(d=>d.deviceId)};}
 assertSettled(){const active=this.data.active;if(!active)return;const config=JSON.parse(fs.readFileSync(path.join(active.directory,'agent.json')));const ledger=JSON.parse(fs.readFileSync(path.join(config.directory,'ledger.json')));if(ledger.state.entries.some(e=>!e.record.resourcesSettled))throw Error('SPACE_SWITCH_BUSY');}
 activate(directory){const config=JSON.parse(fs.readFileSync(path.join(directory,'agent.json')));const active={directory,deviceId:config.identity.deviceId,groupId:config.identity.groupId,address:config.connection.address};this.data.active=active;if(!this.data.known.some(d=>d.deviceId===active.deviceId))this.data.known.push(active);this.save();return active;}
 assertActive(directory){if(this.data.active&&path.resolve(this.data.active.directory)!==path.resolve(directory))throw Error('此设备已切换空间，不能启动旧配对目录');}
}
module.exports={DeviceBinding};
