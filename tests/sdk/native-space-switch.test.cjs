const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),transform=source=>require('esbuild').transformSync(source,{loader:'ts',format:'cjs'}).code;
test('native identity changes preserve old scoped ledgers and do not import old preferences into a new space',async()=>{
 const source=fs.readFileSync(path.join(root,'apps/harmony/scheduler/src/main/ets/v2/host/NativeAgent.ets'),'utf8');
 const start=source.indexOf(' private static async create('),end=source.indexOf(' isConnected():',start);assert.ok(start>0&&end>start);
 const contribution={ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0};
 const bootstrap=holder=>({holderInstanceId:holder,domain:'SIMULATED',contribution,invitation:{version:2,groupId:'group-'+holder,expiresAt:Date.now()+100000,fingerprint:'pin',inviteId:'invite-'+holder}});
 const installation=holder=>({bootstrap:bootstrap(holder),paired:{credential:'c'.repeat(43),peer:{holderInstanceId:holder,groupId:'group-'+holder,deviceId:'device-'+holder}}});
 const saved=new Map([['identity',JSON.stringify(installation('old'))],['ledger','OLD_LEDGER'],['contribution',JSON.stringify(contribution)],['contribution-enabled','false']]);
 let pairs=0,rejectBusy=false,pairFailure=null,lastPair=null;const db={storedIdentities:async()=>[...saved.entries()].filter(([k])=>k==='identity'||k.startsWith('identity:')).map(([,v])=>v),get:async key=>saved.get(key)??null,put:async(key,value)=>saved.set(key,value),ledger:key=>key};
 const module={exports:{}};
 const script=transform('class NativeAgent { constructor(context,db,store,transport,installation,packs){this.installation=installation;this.ledgerKey=store.key;} async restorePreferences(){} async tick(){} '+source.slice(start,end)+'} module.exports=NativeAgent;');
 class Transport {constructor(invite){this.invite=invite;this.lastStatus=0;}async initialize(){}async json(route,body){this.lastStatus=0;if(route==='/v2/identity')return {version:2,domain:'SIMULATED'};if(rejectBusy)throw Error('SPACE_SWITCH_BUSY');if(pairFailure){this.lastStatus=pairFailure.status;throw Error(pairFailure.message);}pairs++;lastPair=body;return installation(body.holderInstanceId).paired;}}
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
 const invite=(holder,inviteId)=>({...bootstrap(holder),invitation:{...bootstrap(holder).invitation,inviteId}});
 // Ambiguous failure (timeout, no response): the same invite is refused, a fresh invite re-pairs.
 pairFailure={status:0,message:'TIMEOUT'};await assert.rejects(module.exports.create(context,invite('lost','i1'),()=>true,null,[]),/TIMEOUT/);
 assert.equal(saved.get('pairing-pending:lost'),'i1');pairFailure=null;
 await assert.rejects(module.exports.create(context,invite('lost','i1'),()=>true,null,[]),/PAIRING_RECONCILIATION_REQUIRED/);
 assert.equal((await module.exports.create(context,invite('lost','i2'),()=>true,null,[])).ledgerKey,'ledger:lost');assert.equal(saved.get('pairing-pending:lost'),'');
 // Ambiguous 5xx keeps the marker; explicit 4xx rejection and unreachable coordinator clear it.
 pairFailure={status:503,message:'HTTP_503'};await assert.rejects(module.exports.create(context,invite('s5','i1'),()=>true,null,[]),/HTTP_503/);assert.equal(saved.get('pairing-pending:s5'),'i1');
 pairFailure={status:401,message:'HTTP_401'};await assert.rejects(module.exports.create(context,invite('s4','i1'),()=>true,null,[]),/HTTP_401/);assert.equal(saved.get('pairing-pending:s4'),'');
 pairFailure={status:-1,message:'TLS_CERTIFICATE_REJECTED'};await assert.rejects(module.exports.create(context,invite('tls','i1'),()=>true,null,[]),/TLS_CERTIFICATE_REJECTED/);assert.equal(saved.get('pairing-pending:tls'),'');
 pairFailure=null;assert.equal((await module.exports.create(context,invite('s4','i1'),()=>true,null,[])).ledgerKey,'ledger:s4');
 // previousDeviceId is only sent to the coordinator that issued it (same certificate pin).
 assert.equal(lastPair.previousDeviceId,'device-lost');
 await module.exports.create(context,{...bootstrap('foreign'),invitation:{...bootstrap('foreign').invitation,fingerprint:'other-pin'}},()=>true,null,[]);
 assert.equal(lastPair.previousDeviceId,undefined);assert.ok(lastPair.knownDeviceIds.includes('device-s4'));
 // Legacy global marker no longer blocks pairing forever.
 saved.set('pairing-pending','legacy');assert.equal((await module.exports.create(context,bootstrap('legacy'),()=>true,null,[])).ledgerKey,'ledger:legacy');assert.equal(saved.get('pairing-pending'),'');
});

test('application runtime switches the existing host instead of silently accepting a different invitation',async()=>{
 const source=fs.readFileSync(path.join(root,'apps/harmony-agent/entry/src/main/ets/AgentRuntime.ets'),'utf8'),module={exports:{}};let active='old',closed=0,busy=false,connected=true,pinOf=id=>'pin-'+id;
 const host=id=>({displayHolderId:()=>id,coordinatorFingerprint:()=>pinOf(id),isConnected:()=>connected,setForeground(){},closeForSwitch:async abandon=>{if(busy&&!abandon)throw Error('SPACE_SWITCH_BUSY');closed++;},close:async()=>{}});
 const NativeAgent={start:async(_ctx,bootstrap)=>{active=bootstrap?.holderInstanceId??active;return host(active);}};
 const storage=new Map();
 new Function('require','module','exports','AppStorage',transform(source))(()=>({NativeAgent}),module,module.exports,{setOrCreate:(key,value)=>storage.set(key,value)});
 await module.exports.openAgent({},null);await module.exports.openAgent({},{holderInstanceId:'new',invitation:{address:'https://new-center.test'}});assert.equal(active,'new');assert.equal(closed,1);
 assert.equal(storage.get('agentPaired'),true);assert.equal(storage.get('agentCenter'),'https://new-center.test');
 busy=true;await assert.rejects(module.exports.openAgent({},{holderInstanceId:'third'}),/SPACE_SWITCH_BUSY/);assert.equal(active,'new');
 assert.equal((await module.exports.openAgent({},null)).displayHolderId(),'new');
 assert.equal(storage.get('agentCenter'),'https://new-center.test','Rejected switches preserve the current displayed center');
 // Old coordinator unreachable and different from the target: its unsettled work cannot block the switch.
 busy=true;connected=false;await module.exports.openAgent({},{holderInstanceId:'fourth',invitation:{address:'https://other.test',fingerprint:'pin-elsewhere'}});assert.equal(active,'fourth');
 // Same coordinator, or old coordinator still connected: busy work still refuses the switch.
 await assert.rejects(module.exports.openAgent({},{holderInstanceId:'fifth',invitation:{address:'https://same.test',fingerprint:'pin-fourth'}}),/SPACE_SWITCH_BUSY/);
 connected=true;await assert.rejects(module.exports.openAgent({},{holderInstanceId:'sixth',invitation:{address:'https://x.test',fingerprint:'pin-x'}}),/SPACE_SWITCH_BUSY/);assert.equal(active,'fourth');
});
