const {test}=require('node:test'),assert=require('node:assert/strict');
const {ControlHeartbeat}=require('../dist/control-heartbeat');

test('busy and idle probes tolerate one miss, ignore stale pongs and scope evidence to the socket',()=>{
 const h=new ControlHeartbeat('old');
 const first=h.tick(0,false);assert.equal(h.tick(4900,false),null);
 assert.equal(h.tick(5000,true),'old:2');assert.equal(h.suspect,false);
 assert.equal(h.reply(first,5020),true);assert.equal(h.reply(first,5021),false);
 h.tick(5500,true);assert.equal(h.suspect,false);
 h.tick(6000,true);assert.equal(h.suspect,true);assert.equal(h.reply('old:2',6001),false);
 assert.equal(h.tick(6500,true),'old:5');assert.equal(h.expired,true);
 const fresh=new ControlHeartbeat('new');fresh.tick(6501,true);assert.equal(fresh.reply('old:5',6502),false);
 assert.equal(fresh.reply('new:1',6503),true);assert.equal(fresh.age(6510),7);
});
