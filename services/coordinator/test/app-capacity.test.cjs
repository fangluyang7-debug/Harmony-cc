const {test}=require('node:test'),assert=require('node:assert/strict');
const {TeamSpaces}=require('../dist/spaces');
const GiB=1073741824;
test('authenticated App inherits device ceiling and space quota rather than its old 256 MiB cap',async()=>{
 const settings={ownerMode:'dedicated',capacityMode:'auto',maxCpuThreads:12,maxMemoryBytes:10*GiB,reserveMemoryBytes:GiB};
 const device={id:'phone',spaceId:'space',holderId:'agent',settingsJson:JSON.stringify(settings)};
 const writes=[];
 const service=Object.create(TeamSpaces.prototype);
 service.apps={context:async()=>({identity:{appInstanceId:'instance',appId:'app'},offlineBase:[]})};
 service.db={spaceDevice:{findUnique:async()=>device,findMany:async()=>[device]},registeredInstallation:{update:async v=>writes.push(v)},registeredApp:{update:async v=>writes.push(v)},$transaction:async v=>Promise.all(v)};
 const result=await service.deviceSettings({deviceId:'phone',groupId:'space',holderInstanceId:'soleai',app:{appInstanceId:'instance'}});
 assert.equal(result.maxMemoryBytes,10*GiB);
 assert.deepEqual(JSON.parse(writes[0].data.onlineJson),[{resourcePoolId:'cpu',amount:12},{resourcePoolId:'ram',amount:10*GiB}]);
 assert.equal(JSON.parse(writes[1].data.resourcesJson)[1].amount,10*GiB);
});
test('App cannot use device settings to cross a space boundary',async()=>{
 const service=Object.create(TeamSpaces.prototype);
 service.db={spaceDevice:{findUnique:async()=>({spaceId:'other'})}};
 assert.equal(await service.deviceSettings({deviceId:'phone',groupId:'space',app:{}}),null);
});
