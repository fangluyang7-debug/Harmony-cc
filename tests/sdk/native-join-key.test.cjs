const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('Harmony cold-entry invitation parser agrees with the web key contract',async()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../../apps/harmony-agent/entry/src/main/ets/JoinInvitation.ets'),'utf8'),code=require('esbuild').transformSync(source,{loader:'ts',format:'cjs'}).code;
 const module={exports:{}};new Function('require','module','exports',code)(()=>({consoleOrigin:value=>{if(!/^https:\/\/[A-Za-z0-9.:-]+$/.test(value))throw Error('ORIGIN');return value;}}),module,module.exports);
 const key='https://192.168.1.10:7443/#join='+'a'.repeat(24)+'&pin='+'b'.repeat(64),r=module.exports.parseJoinInvitation(key);
 assert.equal(r.connection.address,'https://192.168.1.10:7443');assert.equal(r.connection.fingerprint,'b'.repeat(64));assert.equal(r.code,'a'.repeat(24));
 for(const invalid of ['short',key.replace('https:','http:'),key.replace('pin=','pin=bad')])assert.throws(()=>module.exports.parseJoinInvitation(invalid));
});
