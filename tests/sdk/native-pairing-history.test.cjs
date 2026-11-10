const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{transformSync}=require('esbuild');
const m={exports:{}};
new Function('require','module','exports',transformSync(fs.readFileSync('apps/harmony/scheduler/src/main/ets/v2/host/PairingHistory.ets','utf8'),{loader:'ts',format:'cjs'}).code)(()=>({}),m,m.exports);
const install=(id,fingerprint,domain='REAL')=>({bootstrap:{domain,invitation:{fingerprint}},paired:{peer:{deviceId:id}}});
test('new coordinator does not receive foreign device IDs; local history stays intact',()=>{
 const previous=install('old','old-cert'),next=install('new','new-cert'),stored=[previous,next,install('sim','new-cert','SIMULATED')];
 assert.deepEqual(m.exports.pairingHistory(next.bootstrap,previous,stored),{previousDeviceId:undefined,knownDeviceIds:['new']});assert.equal(stored.length,3);
});
test('same coordinator retains membership migration when its network address changes',()=>{
 const previous=install('old','same-cert'),next=install('new','same-cert');
 previous.bootstrap.invitation.address='https://192.168.1.1';next.bootstrap.invitation.address='https://172.20.10.6';
 assert.deepEqual(m.exports.pairingHistory(next.bootstrap,previous,[previous,next]),{previousDeviceId:'old',knownDeviceIds:['old','new']});
});
