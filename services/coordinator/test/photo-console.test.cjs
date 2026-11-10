const {test}=require('node:test'),assert=require('node:assert/strict');
const {AppRegistry}=require('../dist/apps');
test('photo console status resolves current identity without locking a SQLite transaction',async()=>{
 let revoked=false;const owner={groupId:'group',principalId:'owner',deviceId:'phone',holderInstanceId:'source'};
 const db={consoleApp:{findUnique:async()=>({appInstanceId:'installation'})},registeredInstallation:{findUnique:async()=>({id:'installation',appId:'app',deviceId:'phone',holderInstanceId:'holder',state:revoked?'REVOKED':'ACTIVE'})},registeredApp:{findUniqueOrThrow:async()=>({id:'app',groupId:'group',principalId:'owner',contractsJson:'["photo.analyze.v1"]'})},credential:{findFirst:async()=>({id:'credential'})},$transaction:()=>{throw Error('READ_OPENED_TRANSACTION');}};
 const registry=new AppRegistry(db,null,'','SIMULATED');
 const result=await registry.console(owner,[],[]);assert.equal(result.deviceId,'phone');assert.equal(result.app.appInstanceId,'installation');assert.deepEqual(result.app.allowedContracts,['photo.analyze.v1']);
 revoked=true;await assert.rejects(registry.console(owner,[],[]),/APP_CREDENTIAL_REVOKED/);
});
