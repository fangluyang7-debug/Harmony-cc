const {spawnSync}=require('node:child_process'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
// Reuse actual TLS, separate-process restart and durable-ledger probes, keeping evidence in SIMULATED domains.
const runs=[
 {cwd:root,files:['tests/scheduler-lab/deterministic.test.cjs']},
 {cwd:path.join(root,'services/coordinator'),files:['test/recovery-client.test.cjs','test/allotments.test.cjs','test/artifacts.test.cjs','test/qualification.test.cjs','test/agent-integration.test.cjs','test/remote-evaluation.test.cjs','test/cpu-host.test.cjs']}
];
for(const run of runs){const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...run.files],{cwd:run.cwd,stdio:'inherit',windowsHide:true});if(result.status!==0){process.exitCode=result.status??1;break;}}
