const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),transform=source=>require('esbuild').transformSync(source,{loader:'ts',format:'cjs'}).code;
function load(){
 const connection={address:'https://192.168.1.10:7443',fingerprint:'pin',groupId:'old'};let caller=connection.address+'/',calls=0,notifications=0;
 const module={exports:{}};
 const saved=new Map();const dependencies={NativeDatabase:{open:async()=>({storedIdentities:async()=>[],get:async k=>saved.get(k)??null,put:async(k,v)=>saved.set(k,v)})},factory:{id:()=> 'a'.repeat(36)},deviceInfo:{deviceType:'phone'},scanJoinInvitation:async()=> 'https://192.168.1.10:7443/#join='+'a'.repeat(24),openAgent:async()=>{calls++;},consoleOrigin:value=>new URL(value).origin,belongsToConsole:(c,u)=>new URL(u).origin===c.address};
 new Function('require','module','exports',transform(fs.readFileSync(path.join(root,'apps/harmony-agent/entry/src/main/ets/ConsoleDeviceBridge.ets'),'utf8')))(()=>dependencies,module,module.exports);
 const bridge=new module.exports.ConsoleDeviceBridge(()=>({}),()=>connection,()=>caller,async()=>{notifications++;connection.groupId='next';});
 return {bridge,connection,setCaller:value=>{caller=value;},calls:()=>calls,notifications:()=>notifications};
}
test('console device bridge pairs the selected space and exposes only its group id',async()=>{
 const t=load(),bootstrap={invitation:{address:t.connection.address+'/',fingerprint:'pin',groupId:'next',code:'private-invite'},holderInstanceId:'holder'};
 assert.equal(t.bridge.available(),true);
 assert.deepEqual(JSON.parse(await t.bridge.joinDevice(JSON.stringify(bootstrap))),{groupId:'next'});
 assert.equal(t.calls(),1);assert.equal(t.notifications(),1);assert.equal(t.connection.groupId,'next');
});
test('native bridge returns device information and the actual scanned invite result',async()=>{
 const t=load();assert.equal(JSON.parse(await t.bridge.info()).name,'鸿蒙手机');assert.equal(JSON.parse(await t.bridge.info()).groupId,'old');
 const first=JSON.parse(await t.bridge.info());t.connection.groupId='next';assert.equal(JSON.parse(await t.bridge.info()).installationId,first.installationId);
 assert.equal(await t.bridge.scanInvite(),'https://192.168.1.10:7443/#join='+'a'.repeat(24));
 t.setCaller('https://other.example/');await assert.rejects(t.bridge.scanInvite(),/CONSOLE_DEVICE_SCOPE/);
});
test('console bridge does not hand an unrelated origin or mismatched coordinator to the native host',async()=>{
 const t=load(),bootstrap={invitation:{address:t.connection.address+'/',fingerprint:'pin',groupId:'next'}};
 t.setCaller('https://other.example/');await assert.rejects(t.bridge.joinDevice(JSON.stringify(bootstrap)),/CONSOLE_DEVICE_SCOPE/);
 t.setCaller(t.connection.address+'/');
 for(const invitation of [{...bootstrap.invitation,address:'https://other.example/'},{...bootstrap.invitation,fingerprint:'different'}])await assert.rejects(t.bridge.joinDevice(JSON.stringify({invitation})),/CONSOLE_DEVICE_SCOPE/);
 await assert.rejects(t.bridge.joinDevice('x'.repeat(32769)),/CONSOLE_DEVICE_SCOPE/);assert.equal(t.calls(),0);
});
