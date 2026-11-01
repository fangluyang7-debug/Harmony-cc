// Native emulator TLS tests, using deliberately different local certificates. No device credentials.
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const {loadIdentity}=require('../../services/coordinator/dist/identity'),{loadConfig}=require('../../services/coordinator/dist/config');
const root=path.resolve(__dirname,'../..'),hdc=process.env.HDC_PATH||'D:/Users/17321/AppData/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe',target=process.env.HDC_TARGET||'127.0.0.1:5555';
if(!/^127\.0\.0\.1:\d+$/.test(target))throw Error('EMULATOR_TARGET_REQUIRED');
const call=(...args)=>{try{return execFileSync(hdc,['-t',target,...args],{windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']});}catch(e){throw Error('HDC_COMMAND_FAILED:'+String(e.code));}},sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const directory=fs.mkdtempSync(path.join(root,'.test/s2-native-trust-')),report={domain:'SIMULATED',checks:[]};
 const identities=['a','b'].map(name=>loadIdentity(loadConfig({COORDINATOR_DATA_DIR:path.join(directory,name),COORDINATOR_CERTIFICATE_HOST:'127.0.0.1',COORDINATOR_DOMAIN:'SIMULATED'})));
 let hits=0;const server=https.createServer({key:identities[0].key,cert:identities[0].cert},(req,res)=>{hits++;res.setHeader('Content-Type','application/json');if(req.url==='/v2/identity')res.end(JSON.stringify({version:2,domain:'SIMULATED',epoch:1,coordinatorId:identities[0].id}));else{res.statusCode=401;res.end(JSON.stringify({message:'EXPECTED_PAIR_REJECTION'}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;call('rport','tcp:'+port,'tcp:'+port);
 try{
  for(const [name,index,pinError,expected]of [['wrong fingerprint',0,true,'CERTIFICATE_PIN_MISMATCH'],['wrong TLS certificate',1,false,'TLS_CERTIFICATE_REJECTED'],['correct certificate and fingerprint',0,false,'EXPECTED_PAIR_REJECTION']]){
   call('shell','aa','force-stop','org.harmonycc.agent');call('uninstall','org.harmonycc.agent');const installed=call('install',path.join(root,'.test/s2-harmony-agent/entry/build/default/outputs/default/entry-default-unsigned.hap'));assert.match(installed,/install bundle successfully/);
   const cert=identities[index].cert,fingerprint=new crypto.X509Certificate(cert).fingerprint256.replaceAll(':','').toLowerCase();
   const bootstrap={invitation:{version:2,inviteId:crypto.randomUUID(),groupId:crypto.randomUUID(),address:'https://127.0.0.1:'+port,certificate:cert,fingerprint:pinError?'0'.repeat(64):fingerprint,code:crypto.randomBytes(18).toString('base64url'),expiresAt:Date.now()+60000},holderInstanceId:crypto.randomUUID(),domain:'SIMULATED',contribution:{ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0}};
   const before=hits;call('shell','aa','start','-a','EntryAbility','-b','org.harmonycc.agent','--ps','bootstrap',Buffer.from(JSON.stringify(bootstrap)).toString('base64'));
   let found=false;const end=Date.now()+20000;
   while(Date.now()<end){await sleep(300);const pid=call('shell','pidof','org.harmonycc.agent').trim();if(!/^\d+$/.test(pid))continue;const log=call('shell','hilog','-x','-P',pid,'-T','HarmonyAgent');if(log.includes(expected)){found=true;break;}}
   assert.ok(found,name+' native outcome');assert.equal(hits>before,!pinError&&index===0,name+' HTTP reachability');
   report.checks.push({name,status:'PASS',nativeOutcome:expected,httpRequests:hits-before});
  }
 }finally{call('shell','aa','force-stop','org.harmonycc.agent');await new Promise(r=>server.close(r));call('fport','rm','tcp:'+port,'tcp:'+port);fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));console.log('Native TLS report '+path.join(directory,'report.json'));}
 console.log('PASS native TLS: '+report.checks.length+'/3');
}
main().catch(e=>{console.error('Native TLS failed: '+(/^(?:AssertionError|Error)/.test(e.name)?e.message:'ADAPTER_FAILURE'));process.exitCode=1;});
