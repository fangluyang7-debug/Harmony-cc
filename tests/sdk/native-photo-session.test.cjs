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
