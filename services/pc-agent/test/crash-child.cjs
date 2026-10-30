const fs=require('node:fs'),crypto=require('node:crypto');
const {DurableLedger,grantSigningText}=require('../dist/durable-ledger');
(async()=>{
 const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
 const l=await DurableLedger.open(config.directory,config.identity,config.certificate,()=>0);
 l.requestGrant('request1');const grant=config.grant;grant.signature=crypto.sign('sha256',Buffer.from(grantSigningText(grant)),config.key).toString('base64');l.installGrant(grant);
 const entry=l.admit(config.offer,config.context);l.begin(entry.record.attemptId);
 if(process.argv[3]==='after-settlement')l.settle({attemptId:entry.record.attemptId,coordinatorEpoch:1,planRevision:1,fence:entry.record.fence,state:'SUCCEEDED',resourcesSettled:true,outputs:[],actualTarget:entry.offer.target,actualConfiguration:'default',errorCode:null});
 process.exit(17); // Deliberate process death: no graceful ledger close.
})().catch(e=>{process.stderr.write(e.message);process.exit(1);});
