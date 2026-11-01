const fs=require('node:fs'),path=require('node:path'),{execFile,fork}=require('node:child_process');
const command=(file,args)=>new Promise((resolve,reject)=>execFile(file,args,{windowsHide:true,timeout:60000},(e,out,err)=>e?reject(Error('ADAPTER_COMMAND_FAILED:'+String(e.code))):resolve(out)));
exports.start=async(kind,options)=>{
 if(kind==='harmony-emulator'){
  const hdc=process.env.HDC_PATH||'D:/Users/17321/AppData/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe',target=process.env.HDC_TARGET||'127.0.0.1:5555';
  if(!/^127\.0\.0\.1:\d+$/.test(target))throw Error('EMULATOR_TARGET_REQUIRED');
  const call=(...args)=>command(hdc,['-t',target,...args]),hap=process.env.HARMONY_AGENT_HAP||path.join(options.root,'.test/s2-harmony-agent/entry/build/default/outputs/default/entry-default-unsigned.hap');
  if(!fs.existsSync(hap))throw Error('NATIVE_HAP_BUILD_REQUIRED');
  const port=new URL(options.address).port;await call('rport','tcp:'+port,'tcp:'+port);
  await call('uninstall','org.harmonycc.agent').catch(()=>{});
  const installed=await call('install',hap);if(!installed.includes('install bundle successfully'))throw Error('NATIVE_HAP_INSTALL_FAILED');
  // A fresh installation receives its own invitation. No PC process is launched for Harmony.
  const encoded=Buffer.from(fs.readFileSync(options.bootstrap)).toString('base64');
  await call('shell','aa','start','-a','EntryAbility','-b','org.harmonycc.agent','--ps','bootstrap',encoded);
  return {background:async()=>{const probe=path.join(options.root,'.test/s2-harmony-har-probe/entry/build/default/outputs/default/entry-default-unsigned.hap');if(!fs.existsSync(probe))throw Error('PROBE_HAP_BUILD_REQUIRED');const result=await call('install',probe);if(!result.includes('install bundle successfully'))throw Error('PROBE_HAP_INSTALL_FAILED');await call('shell','aa','start','-a','EntryAbility','-b','org.harmonycc.harprobe');},foreground:async()=>{await call('shell','aa','start','-a','EntryAbility','-b','org.harmonycc.agent');},stop:async()=>{await call('shell','aa','force-stop','org.harmonycc.agent');fs.writeFileSync(path.join(options.dir,'harmony-agent.log'),await call('shell','hilog','-x','-T','HarmonyAgent'));await call('fport','rm','tcp:'+port,'tcp:'+port).catch(()=>{});}};
 }
 if(kind==='harmony-device'){
  if(process.env.CONFORMANCE_MANUAL!=='1')throw Error('REAL_DEVICE_SETUP_REQUIRED: set CONFORMANCE_MANUAL=1 and CONFORMANCE_HOST to the LAN IPv4; follow docs/experiments/real-device/S2a.md');
  console.log('Manual native pairing file: '+options.bootstrap);console.log('Install the signed Harmony agent and paste this invitation into its pairing page.');
  return {stop:async()=>{}};
 }
 const {root,dir,bootstrap,settings}=options,installation=path.join(dir,'agent'),policy=path.join(dir,'contribution.json');
 fs.writeFileSync(policy,JSON.stringify(settings),{mode:0o600});
 await command(process.execPath,[path.join(root,'services/pc-agent/dist/pairing-main.js'),bootstrap,installation]);
 const pairedFile=path.join(installation,'agent.json'),paired=JSON.parse(fs.readFileSync(pairedFile));paired.controlIntervalMs=2000;fs.writeFileSync(pairedFile,JSON.stringify(paired),{mode:0o600});
 const log=fs.openSync(path.join(dir,'agent.log'),'a');
 const processHandle=fork(path.join(root,'services/pc-agent/dist/host-main.js'),[path.join(installation,'agent.json'),policy],{windowsHide:true,stdio:['ignore',log,log,'ipc']});
 return {stop:async()=>{if(processHandle.connected){const done=new Promise(r=>processHandle.once('exit',r));processHandle.send('stop');const timer=setTimeout(()=>processHandle.kill(),10000);await done;clearTimeout(timer);}fs.closeSync(log);}};
};
