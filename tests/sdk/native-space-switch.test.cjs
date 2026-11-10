const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),transform=source=>require('esbuild').transformSync(source,{loader:'ts',format:'cjs'}).code;
test('native identity changes preserve old scoped ledgers and do not import old preferences into a new space',async()=>{
 const source=fs.readFileSync(path.join(root,'apps/harmony/scheduler/src/main/ets/v2/host/NativeAgent.ets'),'utf8');
 const start=source.indexOf(' private static async create('),end=source.indexOf(' isConnected():',start);assert.ok(start>0&&end>start);
 const contribution={ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0};
 const bootstrap=holder=>({holderInstanceId:holder,domain:'SIMULATED',contribution,invitation:{version:2,groupId:'group-'+holder,expiresAt:Date.now()+100000,fingerprint:'pin',inviteId:'invite-'+holder}});
 const installation=holder=>({bootstrap:bootstrap(holder),paired:{credential:'c'.repeat(43),peer:{holderInstanceId:holder,groupId:'group-'+holder,deviceId:'device-'+holder}}});
 const saved=new Map([['identity',JSON.stringify(installation('old'))],['ledger','OLD_LEDGER'],['contribution',JSON.stringify(contribution)],['contribution-enabled','false']]);
 let pairs=0,rejectBusy=false;const db={storedIdentities:async()=>[...saved.entries()].filter(([k])=>k==='identity'||k.startsWith('identity:')).map(([,v])=>v),get:async key=>saved.get(key)??null,put:async(key,value)=>saved.set(key,value),ledger:key=>key};
 const module={exports:{}};
 const script=transform('class NativeAgent { constructor(context,db,store,transport,installation,packs){this.installation=installation;this.ledgerKey=store.key;} async restorePreferences(){} async tick(){} '+source.slice(start,end)+'} module.exports=NativeAgent;');
 class Transport {constructor(invite){this.invite=invite;}async initialize(){}async json(route,body){if(route==='/v2/identity')return {version:2,domain:'SIMULATED'};if(rejectBusy)throw Error('SPACE_SWITCH_BUSY');pairs++;return installation(body.holderInstanceId).paired;}}
 class PeerLinks {start(){}}
 new Function('module','NativeDatabase','NativeTransport','AgentStoreV2','NativePeerLinks','validContribution','text','setInterval','factory',script)(module,{open:async()=>db},Transport,{open:async(_binding,key)=>({key,read:()=>({state:{grant:null}})})},PeerLinks,()=>true,x=>x,()=>0,{id:()=> 'a'.repeat(36)});
 const context={resourceManager:{getRawFileContent:async()=> '[]'}};
 const next=await module.exports.create(context,bootstrap('new'),()=>true,null,[]);
 assert.equal(next.ledgerKey,'ledger:new');assert.equal(saved.get('ledger:old'),'OLD_LEDGER');assert.equal(saved.get('contribution-enabled:old'),'false');assert.equal(saved.get('contribution-enabled:new'),undefined);assert.equal(pairs,1);
 saved.set('ledger:new','NEW_LEDGER');await module.exports.create(context,null,()=>true,null,[]);
 assert.equal(saved.get('contribution-enabled:new'),undefined,'restart must not migrate old-space preferences again');
 const back=await module.exports.create(context,bootstrap('old'),()=>true,null,[]);
 assert.equal(back.ledgerKey,'ledger:old');assert.equal(saved.get('ledger:new'),'NEW_LEDGER');assert.equal(pairs,1,'known identity is restored without consuming another invitation');
 await assert.rejects(module.exports.create(context,{...bootstrap('new'),invitation:{...bootstrap('new').invitation,groupId:'wrong'}},()=>true,null,[]),/PAIR_DOMAIN_INVALID/);
 rejectBusy=true;await assert.rejects(module.exports.create(context,bootstrap('busy'),()=>true,null,[]),/SPACE_SWITCH_BUSY/);
 assert.equal(saved.get('pairing-pending:busy'),'');rejectBusy=false;assert.equal((await module.exports.create(context,bootstrap('busy'),()=>true,null,[])).ledgerKey,'ledger:busy');
});

test('application runtime switches the existing host instead of silently accepting a different invitation',async()=>{
 const source=fs.readFileSync(path.join(root,'apps/harmony-agent/entry/src/main/ets/AgentRuntime.ets'),'utf8'),module={exports:{}};let active='old',closed=0,busy=false;
 const host=id=>({displayHolderId:()=>id,setForeground(){},closeForSwitch:async()=>{if(busy)throw Error('SPACE_SWITCH_BUSY');closed++;},close:async()=>{}});
 const NativeAgent={start:async(_ctx,bootstrap)=>{active=bootstrap?.holderInstanceId??active;return host(active);}};
 new Function('require','module','exports',transform(source))(()=>({NativeAgent}),module,module.exports);
 await module.exports.openAgent({},null);await module.exports.openAgent({},{holderInstanceId:'new'});assert.equal(active,'new');assert.equal(closed,1);
 busy=true;await assert.rejects(module.exports.openAgent({},{holderInstanceId:'third'}),/SPACE_SWITCH_BUSY/);assert.equal(active,'new');
 assert.equal((await module.exports.openAgent({},null)).displayHolderId(),'new');
});
