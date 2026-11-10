const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),ts=require('typescript');
function load(saved={}){
 const source=fs.readFileSync(path.resolve(__dirname,'../../apps/harmony-agent/entry/src/main/ets/ConsoleConnection.ets'),'utf8');
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports={},context={exports,require:()=>({NativeDatabase:{open:async()=>({get:async key=>saved[key]??null,put:async(key,value)=>{saved[key]=value;}})},hash:bytes=>crypto.createHash('sha256').update(bytes).digest('hex')})};
 vm.runInNewContext(output,context);return exports;
}
test('paired console exposes only the coordinator origin, group and certificate pin',async()=>{
 const api=load({identity:JSON.stringify({bootstrap:{invitation:{address:'https://192.168.1.10:7443/',fingerprint:'pin',code:'private-invitation'}},paired:{credential:'private-device-credential',peer:{groupId:'group'}}})});
 assert.equal(JSON.stringify(await api.consoleConnection({})),JSON.stringify({address:'https://192.168.1.10:7443',groupId:'group',fingerprint:'pin'}));
});
test('in-app certificate trust requires the paired origin and exact leaf fingerprint',()=>{
 const api=load(),certificate=Buffer.from('test DER bytes'),connection={address:'https://192.168.1.10:7443',groupId:'group',fingerprint:crypto.createHash('sha256').update(certificate).digest('hex')};
 assert.equal(api.matchesConsoleCertificate(connection,connection.address+'/dispatch.html',certificate),true);
 assert.equal(api.matchesConsoleCertificate(connection,connection.address+'.example/dispatch.html',certificate),false);
 assert.equal(api.matchesConsoleCertificate(connection,connection.address+'/dispatch.html',Buffer.from('changed')),false);
 assert.equal(api.matchesConsoleCertificate({...connection,fingerprint:''},connection.address+'/',certificate),false);
});
test('unpaired connection persists a public HTTPS origin without granting certificate trust',async()=>{
 const api=load();assert.equal(await api.consoleConnection({}),null);
 await api.saveConsoleAddress({},' https://example.com/ ');
 assert.equal(JSON.stringify(await api.consoleConnection({})),JSON.stringify({address:'https://example.com',groupId:'',fingerprint:''}));
 for(const address of ['http://example.com','https://example.com/path','https://user@example.com','javascript:alert(1)'])assert.throws(()=>api.consoleOrigin(address));
});
