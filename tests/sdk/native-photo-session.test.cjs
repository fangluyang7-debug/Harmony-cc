const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{transformSync}=require('esbuild');
test('switching to local work waits for the cooperative host to settle and preserves it if settlement fails',async()=>{
 const code=transformSync(fs.readFileSync('apps/harmony-photo/entry/src/main/ets/PhotoSession.ets','utf8'),{loader:'ts',format:'cjs'}).code,m={exports:{}};
 new Function('require','module','exports',code)(()=>({}),m,m.exports);
 const session=new m.exports.PhotoSession();let settled=false,fail=true;
 const host={closeForSwitch:async()=>{await new Promise(r=>setTimeout(r,5));if(fail)throw Error('SPACE_SWITCH_BUSY');settled=true;}};
 session.host=host;session.port={};await assert.rejects(session.prepareLocal(),/SPACE_SWITCH_BUSY/);assert.equal(session.host,host);assert.notEqual(session.port,null);
 fail=false;await session.prepareLocal();assert.equal(settled,true);assert.equal(session.host,null);assert.equal(session.port,null);
 await session.prepareLocal();
});
for(const blocked of [false,true])test('stale center timeout '+(blocked?'keeps unsettled work and prevents reauthorization':'reauthorizes through the current device app'),async()=>{
 const old={appInstanceId:'old-app'},values=new Map([['installation',JSON.stringify(old)]]),events=[];
 const store={get:async(k,fallback)=>values.has(k)?values.get(k):fallback,put:async(k,v)=>values.set(k,v),flush:async()=>{}};
 const registration={address:'https://current-center:7443',registrationId:'registration',code:'code',expiresAt:Date.now()+60000,domain:'REAL'};
 const paired={credential:'new-credential',peer:{groupId:'new-space',deviceId:'phone',holderInstanceId:'new-holder'}};
 const port={exchange:async()=>{events.push('exchange');return JSON.stringify(paired);},request:async()=>JSON.stringify({identity:{appInstanceId:'new-app'}})};
 const code=transformSync(fs.readFileSync('apps/harmony-photo/entry/src/main/ets/PhotoSession.ets','utf8'),{loader:'ts',format:'cjs'}).code,m={exports:{}};
 new Function('require','module','exports',code)(name=>name==='@kit.ArkData'?{preferences:{getPreferences:async()=>store}}:name==='scheduler'?{HarmonySdkPort:{open:async()=>port}}:{},m,m.exports);
 const session=new m.exports.PhotoSession();session.initialize({startAbilityForResult:async()=>{events.push('authorize');return {resultCode:0,want:{parameters:{registration:JSON.stringify(registration)}}};}});
 session.host={closeForSwitch:async()=>{events.push('settle');if(blocked)throw Error('SPACE_SWITCH_BUSY');}};
 session.activate=async i=>{if(i.appInstanceId==='old-app')throw Error('Operation timeout');events.push('activate');session.installation=i;};
 const statuses=[];
 if(blocked){await assert.rejects(session.connect(false,s=>statuses.push(s)),/SPACE_SWITCH_BUSY/);assert.deepEqual(events,['settle']);assert.equal(JSON.parse(values.get('installation')).appInstanceId,'old-app');}
 else{await session.connect(false,s=>statuses.push(s));assert.deepEqual(events,['settle','authorize','exchange','activate']);assert.equal(session.connection().groupId,'new-space');assert.equal(values.get('exchangePending'),false);assert.equal(JSON.parse(values.get('previousInstallation')).appInstanceId,'old-app');assert.ok(statuses.includes('授权已收到，正在连接当前协作空间…'));}
 assert.equal(session.changing,false);
});
