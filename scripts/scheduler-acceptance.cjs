// S8 / D9. Run the local software cases on this checkout; no device driver is started.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),started=new Date();
const date=[started.getFullYear(),String(started.getMonth()+1).padStart(2,'0'),String(started.getDate()).padStart(2,'0')].join('-');
const dest=path.join(root,'artifacts','acceptance',date);
const node=process.execPath,coord='services/coordinator',pc='services/pc-agent';
const tests=(cwd,...files)=>({cwd,args:['--test','--test-concurrency=1','--test-reporter=tap',...files],tap:true});
const suites={
 architecture:{cwd:'.',args:['scripts/check-architecture.mjs']},
 violations:tests('.','scripts/check-architecture.test.mjs'),
 boundary:{cwd:'.',args:['scripts/check-s4-core-baseline.cjs']},
 sdk:tests(coord,'test/sdk-host.test.cjs'),planning:tests(coord,'test/planning.test.cjs'),
 directory:tests(coord,'test/directory.test.cjs'),display:tests(coord,'test/display-sessions.test.cjs'),
 gpu:tests(coord,'test/image-encoder-host.test.cjs'),store:tests(coord,'test/store.test.cjs'),
 qualification:tests(coord,'test/qualification.test.cjs'),links:tests(coord,'test/direct-transfers.test.cjs'),
 teamSearch:{...tests('.','services/api-server/test/image-search-v2.test.cjs'),env:{HARMONY_IMAGE_TEAM_TEST:'1'}},
 nativeImage:tests('.','tests/sdk/native-image-encoder.test.cjs','tests/sdk/indexer-storage.test.cjs'),
 fairness:tests(coord,'test/batch-ready.test.cjs','test/two-app-hosts.test.cjs'),
 relay:{...tests(coord,'test/workflow.test.cjs'),env:{HARMONY_TEST_BLOCK_BC:'1'}},
 apps:tests(coord,'test/apps.test.cjs'),auth:tests(coord,'test/auth.test.cjs'),
 allotments:tests(coord,'test/allotments.test.cjs'),queue:tests(pc,'test/scheduler.test.cjs'),
 ledger:tests(pc,'test/ledger.test.cjs'),conformance:{cwd:'.',args:['tests/agent-conformance/run.cjs','--agent','pc']}
};
const criteria=[
 ['App 解耦',['architecture','violations','boundary','sdk','nativeImage','teamSearch'],'S4 摘要覆盖记录的接入前后边界；三条图像路径使用替身编码器。','两个独立 App 同机切换、共享 HAR、真实输入输出。'],
 ['终端解耦',['architecture','violations','conformance','planning'],'本次覆盖 PC 一致性与设备改名对照；模拟器运行单独登记。','PC 与鸿蒙手机在同一协议及局域网下运行。'],
 ['宏微联合与执行语义',['gpu','store','ledger','queue','relay'],'CUDA 后端与显存读数来自测试替身。','实际 CUDA 权重、显存、共享内存争用及断线重启。'],
 ['资源完整',['directory','links','display','planning','relay'],'展示确认覆盖 HTTPS 协议；模拟器页面呈现单独登记。','真实温度、电量、链路变化和接收端屏幕确认。'],
 ['单一派发与有界规划',['architecture','violations','planning','sdk'],'虚拟时钟覆盖预算回退；本机线性 DAG 规划耗时见 AC5.json。','决赛拓扑下的控制时延与规划耗时。'],
 ['自动接入与反馈',['qualification','sdk','links'],'性能漂移和时钟变化使用受控输入。','真实模型测量、热降频及断路恢复。'],
 ['安全与隔离',['apps','auth','links','display','store'],'本次覆盖软件身份、会话、制品和回执作用域。','ODID、沙箱身份与权限撤销的真机交叉验证。'],
 ['设备内调度与额度',['allotments','queue','ledger','conformance','fairness'],'双 App 在已确认双槽容量内竞争；设备等待界限须结合前提判读。','所有者活动切换、后台暂停与未结算资源保护。']
];
const git=(...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024});if(r.status!==0)throw Error('Cannot identify checkout');return r.stdout;};
const sourceHash=createHash('sha256');
for(const file of git('ls-files','-co','--exclude-standard','-z').split('\0').filter(Boolean).sort()){
 const full=path.join(root,file);if(!fs.existsSync(full)||!fs.statSync(full).isFile())continue;
 sourceHash.update(file+'\0').update(createHash('sha256').update(fs.readFileSync(full)).digest());
}
const environment={startedAt:started.toISOString(),node:process.version,platform:process.platform,arch:process.arch,
 osRelease:os.release(),commit:git('rev-parse','HEAD').trim(),dirty:!!git('status','--porcelain').trim(),sourceDigest:sourceHash.digest('hex')};
fs.mkdirSync(dest,{recursive:true});
const evidence={};
for(const [key,suite] of Object.entries(suites)){
 console.log('Running '+key);
 const t=Date.now(),r=spawnSync(node,suite.args,{cwd:path.join(root,suite.cwd),env:{...process.env,...suite.env},encoding:'utf8',timeout:300000,maxBuffer:16*1024*1024,windowsHide:true});
 const stdout=r.stdout??'',cases=[];
 if(suite.tap)for(const m of stdout.matchAll(/^(not ok|ok) \d+ - (.*)$/gm)){
   const name=m[2].trim();cases.push({name,result:/ # (SKIP|TODO)\b/i.test(name)?'NOT_RUN':m[1]==='ok'?'PASS':'FAIL'});
 }
 if(key==='conformance'){
   const relative=stdout.match(/^(?:Evidence|Report):?\s+([^\r\n]+)/im)?.[1]?.trim();
   if(relative){
     const location=path.resolve(root,relative);
     if(location.startsWith(path.join(root,'.test')+path.sep)){
       const file=fs.statSync(location).isDirectory()?path.join(location,'report.json'):location;
       for(const item of JSON.parse(fs.readFileSync(file,'utf8')).checks)cases.push({name:item.name,result:item.status});
     }
   }
 }
 const counted=suite.tap||key==='conformance';
 const result=r.status===0&&(!counted||cases.length&&cases.every(c=>c.result==='PASS'))?'PASS':'FAIL';
 evidence[key]={category:'SIMULATED',cwd:suite.cwd,command:['node',...suite.args],env:suite.env??{},result,exitCode:r.status,signal:r.signal,
   durationMs:Date.now()-t,cases,outputSha256:createHash('sha256').update(stdout).digest('hex')};
 if(result==='FAIL')console.error(key+' failed; rerun the recorded command for diagnostics.');
}
const summary=['# 调度 v2 本机软件验收', '',environment.startedAt+' · '+environment.platform+' '+environment.arch+' · Node '+environment.node,
 '', '本轮仅执行本机软件用例。表中的通过数按测试命令统计，各项仍需结合覆盖说明和待设备项判读。','',
 '| 项目 | 本机通过 / 执行 | 本次覆盖边界 | 待设备验收 |','| --- | --- | --- | --- |'];
for(const [i,[title,keys,scope,physical]] of criteria.entries()){
 const id='AC'+(i+1),selected=keys.map(k=>evidence[k]),passed=selected.filter(s=>s.result==='PASS').length;
 const report={id,title,environment,simulation:{result:passed===selected.length?'LISTED_CASES_PASS':'FAILED',coverage:scope,suites:selected},
   real:{result:'NOT_RUN',pending:[physical]}};
 if(id==='AC5')report.simulation.planningBenchmark=require('./benchmark-scheduler-planning.cjs').benchmark();
 fs.writeFileSync(path.join(dest,id+'.json'),JSON.stringify(report,null,2)+'\n');
 summary.push('| ['+id+']('+id+'.json) '+title+' | '+passed+' / '+selected.length+' | '+scope+' | '+physical+' |');
}
fs.writeFileSync(path.join(dest,'SUMMARY.md'),summary.join('\n')+'\n');
console.log(path.relative(root,path.join(dest,'SUMMARY.md')));
if(Object.values(evidence).some(s=>s.result!=='PASS'))process.exitCode=1;
