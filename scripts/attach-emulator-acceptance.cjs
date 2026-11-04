// Supplement a local report with completed SIMULATED runs. Never import device evidence as emulator data.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const [dir,protocolFile,displayFile,hap,api,queueLog,probeHap]=process.argv.slice(2);
if(!dir||!protocolFile||!displayFile||!hap||!api)throw Error('Usage: REPORT_DIR PROTOCOL_JSON DISPLAY_JSON TESTED_HAP API');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8')),digest=b=>createHash('sha256').update(b).digest('hex');
const protocol=read(protocolFile),screen=read(displayFile),artifactHash=digest(fs.readFileSync(hap));
if(protocol.hapSha256!==artifactHash||screen.hapSha256!==artifactHash||
 protocol.agent!=='harmony-emulator'||protocol.domain!=='SIMULATED'||!protocol.finishedAt||!Array.isArray(protocol.checks)||
 protocol.checks.length<8||!protocol.checks.every(c=>c.status==='PASS')||protocol.errors.length||
 screen.domain!=='SIMULATED'||String(screen.api)!==api||!Array.isArray(screen.checks)||screen.checks.length!==5)throw Error('EMULATOR_EVIDENCE_INCOMPLETE');
const records=['protocol','display'].map((test,i)=>({test,domain:'SIMULATED',api,hapSha256:artifactHash,
 evidenceSha256:digest(fs.readFileSync([protocolFile,displayFile][i])),cases:i?screen.checks:protocol.checks.map(c=>c.name)}));
let queue=null;
if(queueLog||probeHap){
 if(!queueLog||!probeHap||!fs.readFileSync(queueLog,'utf8').includes('queue interference/expiry=PASS'))throw Error('NATIVE_QUEUE_EVIDENCE_INCOMPLETE');
 queue={test:'native-queue',domain:'SIMULATED',api,hapSha256:digest(fs.readFileSync(probeHap)),evidenceSha256:digest(fs.readFileSync(queueLog)),
  cases:['measured interference delays shared-pool admission','independent pool and owner gate','unstarted wait cap','admission resumes after settlement']};
}
for(const n of [2,3,4,7,8]){
 const file=path.join(dir,'AC'+n+'.json'),report=read(file);
 report.simulation.emulator=n===4?[records[1]]:n===8&&queue?[records[0],queue]:[records[0]];
 fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
}
const file=path.join(dir,'SUMMARY.md'),heading='## 补充模拟器实测';
const initial=fs.readFileSync(file,'utf8').split(heading)[0].trimEnd();
fs.writeFileSync(file,initial+'\n\n'+heading+'\n\nHarmonyOS API '+api+'，同一展示端 HAP。协议一致性 '+protocol.checks.length+
 '/'+protocol.checks.length+'，另已在页面上验证两版结果、旧版本拒绝、点击确认、撤销清屏和退出会话。相关 JSON 的 emulator 字段保存用例名与证据摘要。项目规定的 API 22、真机和真实模型验收继续单列。\n');
