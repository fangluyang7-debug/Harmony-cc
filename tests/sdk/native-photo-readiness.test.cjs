const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{transformSync}=require('esbuild');
test('native readiness uses current own-target qualification, not merely a control connection',async()=>{
 const source=fs.readFileSync('apps/harmony/scheduler/src/main/ets/v2/host/NativeAgent.ets','utf8'),start=source.indexOf(' async pendingCapabilities('),end=source.indexOf('\n /**',start),m={exports:{}};
 const code=transformSync('class Host {'+source.slice(start,end)+'} module.exports=Host;',{loader:'ts',format:'cjs'}).code;
 new Function('module','validCapabilityAdmissionV2',code)(m,a=>a!==null&&typeof a==='object');
 const executor={contract:{capability:'photo.deliver.v1'},target:{targetId:'own-target'}};
 const ready={groupId:'g',holderInstanceId:'h',targetId:'own-target',domain:'REAL',identity:'digest',state:'ACTIVE',quality:{value:1,sampledAt:100,ttlMs:1000}};
 let admission=ready,connected=true,idle=true,requests=0;
 const host=new m.exports();Object.assign(host,{isConnected:()=>connected,idle:()=>idle,executors:()=>[executor],executorDigest:()=> 'digest',packs:[{manifest:{contract:executor.contract,qualityThreshold:1}}],installation:{paired:{peer:{groupId:'g',holderInstanceId:'h'}},bootstrap:{domain:'REAL'}},transport:{now:()=>200,json:async path=>{requests++;assert.equal(path,'/v2/qualification/own-target');return {admission};}}});
 const pending=()=>host.pendingCapabilities(['photo.deliver.v1']);
 connected=false;assert.deepEqual(await pending(),['控制连接']);connected=true;idle=false;assert.deepEqual(await pending(),['手机前台贡献']);assert.equal(requests,0);idle=true;
 for(const invalid of [null,{state:'CALIBRATING'},{groupId:'other'},{holderInstanceId:'old-holder'},{targetId:'other-target'},{domain:'SIMULATED'},{identity:'old-digest'},{quality:{value:0.9,sampledAt:100,ttlMs:1000}},{quality:{value:1,sampledAt:0,ttlMs:200}}]){
  admission=invalid===null?null:{...ready,...invalid};assert.deepEqual(await pending(),['photo.deliver.v1']);
 }
 for(const state of ['CANARY','ACTIVE']){admission={...ready,state};assert.deepEqual(await pending(),[]);}
 await assert.rejects(host.pendingCapabilities(['not-installed']),/本机缺少处理能力/);
});
