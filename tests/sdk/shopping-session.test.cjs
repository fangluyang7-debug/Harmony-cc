const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{transformSync}=require('esbuild');
test('one explicit enrollment creates an App host; relaunch resumes silently; lost membership makes new work local',async()=>{
 const values=new Map(),ui=new Map();let approvals=0,starts=0,revoked=false,foreground=[];
 const prefs={get:async(k,d)=>values.has(k)?values.get(k):d,put:async(k,v)=>{values.set(k,v);},flush:async()=>{}};
 const identity={groupId:'space',deviceId:'phone',holderInstanceId:'app-holder',principalId:'owner',credentialId:'app-credential'};
 const host={displayHolderId:()=>identity.holderInstanceId,isConnected:()=>true,sdk:async()=>({source:'APP_HOST'}),setForeground:v=>foreground.push(v),close:async()=>{}};
 const port={request:async route=>{if(revoked)throw Error('DEVICE_LEFT_SPACE');return JSON.stringify({identity:{appInstanceId:'app-installation'},declaration:{revision:'soleai.shopping.3'}});},exchange:async()=>JSON.stringify({credential:'app-secret',peer:identity,offlineBase:[],onlineExtra:[{resourcePoolId:'cpu',amount:2}]})};
 const context={startAbilityForResult:async want=>{approvals++;assert.equal(want.abilityName,'EnrollmentAbility');const manifest=JSON.parse(want.parameters.declaration);assert.ok(manifest.allowedContracts.includes('image.visual-match.v1'));return {resultCode:0,want:{parameters:{registration:JSON.stringify({registrationId:'grant',code:'one-time',expiresAt:Date.now()+10000,domain:'SIMULATED',address:'https://fixture',certificate:'test-ca',fingerprint:'test-pin'})}}};}};
 const code=transformSync(fs.readFileSync('apps/harmony/entry/src/main/ets/services/CooperativeSession.ets','utf8'),{loader:'ts',format:'cjs'}).code;
 function create(){const m={exports:{}};new Function('require','module','exports','AppStorage',code)(name=>name==='scheduler'?{HarmonySdkPort:{open:async()=>port},NativeAgent:{start:async(_context,bootstrap,foreground,installation)=>{starts++;assert.equal(bootstrap,null);assert.equal(installation.appInstanceId,'app-installation');assert.equal(installation.paired.credential,'app-secret');return host;}}}:name==='@kit.ArkData'?{preferences:{getPreferences:async()=>prefs}}:{},m,m.exports,{setOrCreate:(k,v)=>{if(!ui.has(k))ui.set(k,v);},set:(k,v)=>ui.set(k,v),get:k=>ui.get(k)});return m.exports.cooperative;}
 const session=create();session.initialize(context);session.lifecycle(true);await session.restore();assert.equal(approvals,0);assert.equal(starts,0);
 await session.setEnabled(true);assert.equal(approvals,1);assert.equal((await session.availableClient()).source,'APP_HOST');assert.equal(starts,1);
 session.lifecycle(false);assert.equal(foreground.at(-1),false);assert.equal(await session.availableClient(),null);await session.close();
 const restarted=create();restarted.initialize(context);restarted.lifecycle(true);await restarted.restore();assert.equal(approvals,1);assert.equal(starts,2);assert.equal((await restarted.availableClient()).source,'APP_HOST');
 revoked=true;assert.equal(await restarted.availableClient(),null);assert.equal(restarted.enabled(),false);assert.equal(approvals,1,'normal work never opens an enrollment screen');
});
test('background native host returns discretionary quota without deleting its occupancy or base grant',async()=>{
 const source=fs.readFileSync('apps/harmony/scheduler/src/main/ets/v2/host/NativeAgent.ets','utf8'),start=source.indexOf(' private async renew():'),end=source.indexOf(' private async ackQuota()',start);
 const code=transformSync('class Host {'+source.slice(start,end)+'} module.exports=Host;', {loader:'ts',format:'cjs'}).code,m={exports:{}};const calls=[];
 new Function('module','canonical','monotonic','factory','HostChange','requestGrantV2','installGrantV2',code)(m,JSON.stringify,()=>100,{id:()=>String(calls.length)},class{constructor(f){this.f=f;}},s=>s,s=>s);
 const host=new m.exports();let idle=true;Object.assign(host,{ready:true,grantBusy:false,policy:{offlineBase:[{resourcePoolId:'ram',amount:64}],onlineExtra:[{resourcePoolId:'cpu',amount:2}]},idle:()=>idle,renewAt:0,store:{change:async c=>c.f({state:{ledgerEpoch:1}}),read:()=>({state:{ledgerEpoch:1}})},transport:{json:async(_route,body)=>{calls.push(body);return {leaseMs:60000};},verify:()=>true},ackQuota:async()=>{}});
 await host.renew();idle=false;await host.renew();assert.deepEqual(calls[0].extra,[{resourcePoolId:'cpu',amount:2}]);assert.deepEqual(calls[1].extra,[]);assert.deepEqual(calls[1].base,calls[0].base);
 idle=true;await host.renew();assert.deepEqual(calls[2].extra,calls[0].extra);
});
