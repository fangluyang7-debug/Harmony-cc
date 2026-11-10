const fs=require('node:fs'),path=require('node:path'),{fork,spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
class HostManager {
 constructor(directory,runtime,executable=process.execPath){this.directory=directory;this.runtime=runtime;this.executable=executable;this.child=null;this.busy=false;this.error='';fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'installation-id');try{fs.writeFileSync(file,randomUUID(),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}this.installationId=fs.readFileSync(file,'utf8').trim();}
 active(){try{return JSON.parse(fs.readFileSync(path.join(this.directory,'active.json')));}catch{return null;}}
 status(){const a=this.active(),knownDeviceIds=[];for(const entry of fs.readdirSync(this.directory,{withFileTypes:true})){if(!entry.isDirectory())continue;try{const id=JSON.parse(fs.readFileSync(path.join(this.directory,entry.name,'agent.json'))).identity.deviceId;if(typeof id==='string')knownDeviceIds.push(id);}catch{}}return {installationId:this.installationId,knownDeviceIds,groupId:a?.groupId??'',deviceId:a?.deviceId??'',running:!!this.child,error:this.error};}
 run(script,args){return new Promise((resolve,reject)=>{const p=spawn(this.executable,[path.join(this.runtime,script),...args],{windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','ignore','pipe']});p.on('error',()=>reject(Error('AGENT_PROCESS_START_FAILED')));p.once('exit',code=>code===0?resolve():reject(Error('DEVICE_PAIRING_FAILED')));p.stderr.resume();});}
 async start(active=this.active()){
  if(!active||this.child)return;this.error='';
  const log=fs.openSync(path.join(this.directory,'agent.log'),'a');
  const child=fork(path.join(this.runtime,'host-main.js'),[active.config,active.policy],{execPath:this.executable,execArgv:[],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:['ignore','pipe',log,'ipc']});fs.closeSync(log);this.child=child;
  child.once('exit',()=>{if(this.child===child){this.child=null;this.error='代理已停止，请点击重新连接。';}});
  try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('AGENT_START_TIMEOUT')),process.env.HARMONY_PHOTO_RUNTIME||fs.existsSync(path.join(this.runtime,'photo/runtime.json'))?150000:20000);child.stdout.on('data',data=>{if(String(data).includes('CPU host started:')){clearTimeout(timer);resolve();}});child.once('error',()=>{clearTimeout(timer);reject(Error('AGENT_PROCESS_START_FAILED'));});child.once('exit',()=>{clearTimeout(timer);reject(Error('AGENT_PROCESS_EXITED'));});});}
  catch(error){if(child.exitCode===null){await new Promise(resolve=>{child.once('exit',resolve);child.kill();});}if(this.child===child)this.child=null;throw error;}
 }
 async stop(){const child=this.child;if(!child)return;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('SPACE_SWITCH_BUSY')),20000);child.once('exit',()=>{clearTimeout(timer);resolve();});try{child.send('stop');}catch{clearTimeout(timer);reject(Error('AGENT_STOP_FAILED'));}});this.child=null;this.error='';}
 async join(encoded){
  if(this.busy)throw Error('SPACE_SWITCH_BUSY');this.busy=true;
  try{
   const d=JSON.parse(encoded);if(!/^[a-f0-9-]{36}$/.test(d.holderInstanceId)||!d.invitation||!['REAL','SIMULATED'].includes(d.domain))throw Error('INVITATION_INVALID');
   const previous=this.active();
   if(previous&&this.child){const old=JSON.parse(fs.readFileSync(previous.config)),ledger=JSON.parse(fs.readFileSync(path.join(old.directory,'ledger.json')));if(ledger.state.entries.some(e=>!e.record.resourcesSettled))throw Error('SPACE_SWITCH_BUSY');}
   const dir=path.join(this.directory,d.holderInstanceId),config=path.join(dir,'agent.json'),policy=path.join(this.directory,d.holderInstanceId+'-policy.json');
   // Stop/drain before pairing: successful exchange atomically retires the old membership.
   await this.stop();
   try{if(!fs.existsSync(config)){const file=path.join(this.directory,d.holderInstanceId+'-invitation.json');fs.writeFileSync(file,JSON.stringify({...d,localDevice:this.status()}));await this.run('pairing-main.js',[file,dir]);fs.unlinkSync(file);}}
   catch(error){if(previous)await this.start(previous).catch(()=>{});throw error;}
   const identity=JSON.parse(fs.readFileSync(config)).identity;if(identity.groupId!==d.invitation.groupId)throw Error('PAIR_DOMAIN_INVALID');
   fs.writeFileSync(policy,JSON.stringify(d.contribution));await this.stop();
   const active={groupId:identity.groupId,deviceId:identity.deviceId,config,policy};
   // Once paired, persist the new binding even if startup fails. The previous credential is retired.
   fs.writeFileSync(path.join(this.directory,'active.json'),JSON.stringify(active));await this.start(active);return JSON.stringify({groupId:identity.groupId});
  }finally{this.busy=false;}
 }
}
module.exports={HostManager};
