import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {createRequire} from 'node:module';
const root=new URL('../',import.meta.url),require=createRequire(import.meta.url);
const tsCore=require('../packages/scheduler-core/dist/index.js');
const prefix='apps/harmony/scheduler/src/main/ets/v2/';
function load(file,deps={}){
 const exports={};const source=fs.readFileSync(new URL(prefix+file+'.ets',root),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:n=>{if(!deps[n])throw Error('UNEXPECTED_IMPORT '+n);return deps[n];}});return exports;
}
const protocol=load('protocol/SchedulingProtocolV2');
const resources=load('protocol/ResourcesV2',{'./SchedulingProtocolV2':protocol});
const canonical=load('core/CanonicalV2');
const arkCore=load('core/LedgerV2',{'./CanonicalV2':canonical,'../protocol/SchedulingProtocolV2':protocol,'../protocol/ResourcesV2':resources});
const arkQueue=load('core/MicroQueueV2',{'../protocol/ResourcesV2':resources,'./LedgerV2':arkCore});
function execute(api,fixture){
 const s=JSON.parse(fixture.stateJSON),a=JSON.parse(fixture.argJSON);
 switch(fixture.method){
  case 'new':return api.newLedgerV2(a);
  case 'request':return api.requestGrantV2(s,a.id,a.now);
  case 'install':return api.installGrantV2(s,a.grant,a.verified,a.now);
  case 'admit':return api.admitV2(s,a.offer,a.context);
  case 'start':return api.startAttemptV2(s,a.attemptId,a.now);
  case 'cancel':return api.cancelAttemptV2(s,a.attemptId);
  case 'recover':return api.recoverLedgerV2(s);
  case 'occupied':return api.occupiedV2(s);
  case 'pools':return api.ledgerPoolsV2(s,a.limits);
  case 'settle':return api.settleAttemptV2(s,a.receipt);
  default:throw Error('UNKNOWN_FIXTURE_METHOD');
 }
}
const fixtures=JSON.parse(fs.readFileSync(new URL('tests/agent-conformance/fixtures/ledger-v2.json',root)));
for(const [name,api]of [['TS',tsCore],['ArkTS-transpiled',{...arkCore,...canonical}]])for(const f of fixtures){
 let result='',error='';try{result=api.canonical(execute(api,f));}catch(e){error=e.message;}
 assert.equal(error,f.expectedError,name+' '+f.name+' error');assert.equal(result,f.expectedJSON,name+' '+f.name+' result');
}
console.log(`PASS ledger parity: ${fixtures.length} shared fixtures x TS/ArkTS (native execution requires HAP probe)`);
function queueScenario(Queue){
 const template=JSON.parse(fs.readFileSync(new URL('contracts/scheduling/v2/fixtures/t2/valid/DispatchOffer.json',root))),limits=[{resourcePoolId:'cpu1',amount:1},{resourcePoolId:'memory1',amount:100}],out=[];
 const queue=new Queue(template.target.deviceId,{shares:[.5,.3,.2],agingMs:100,maxConsecutive:2,yieldDeadlineMs:1000});
 for(const [index,priority]of ['ORIGIN_INTERACTIVE','REMOTE_INTERACTIVE','REMOTE_BATCH'].entries()){const offer=structuredClone(template);offer.task.attemptId='queue-'+index;offer.task.priority=priority;offer.task.budget={remainingMs:10000,deadlineAt:10000};queue.enqueue(offer,0);}
 out.push(queue.choose(limits,[],0,false));queue.start('queue-0',1);out.push(queue.ownerYield(2));queue.settle('queue-0',10);
 out.push(queue.choose(limits,[],10,true));queue.start('queue-1',10);out.push(queue.ownerYield(11));out.push(queue.credits(new Map([['REMOTE_BATCH',limits]]),limits,limits,true));queue.settle('queue-1',20);
 out.push(queue.choose(limits,[],20,true));out.push(queue.expired(10001));
 const bad=structuredClone(template);bad.target.deviceId='foreign';try{queue.enqueue(bad,0);}catch(e){out.push(e.message);}return JSON.stringify(out);
}
assert.equal(queueScenario(arkQueue.MicroQueueV2),queueScenario(tsCore.MicroQueue));
console.log('PASS TS/ArkTS micro queue parity: selection, running debt, yield, credits, expiry and foreign target rejection');
