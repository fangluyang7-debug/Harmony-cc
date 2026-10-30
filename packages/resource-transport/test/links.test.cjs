const {test}=require('node:test'),assert=require('node:assert/strict');
const {DirectionalLinks}=require('../dist');
test('directional fits use mixed sizes within one network epoch; stale and switched-network samples cannot seed a fit',()=>{
 const links=new DirectionalLinks('SIMULATED');
 for(const bytes of [100,500,1000])links.observe('a','b','net1','net1','SIMULATED',{bytes,durationMs:5+bytes/10,observedAt:100});
 const fit=links.estimate('a','b','net1',100);assert.ok(Math.abs(fit.fixedMs-5)<0.0001);assert.ok(Math.abs(fit.bytesPerSecond-10000)<0.01);
 assert.equal(links.estimate('b','a','net1',100),undefined);assert.equal(links.estimate('a','b','net2',100),undefined);assert.equal(links.estimate('a','b','net1',40000),undefined);
 links.observe('a','b','net2','net3','SIMULATED',{bytes:100,durationMs:1,observedAt:100});assert.equal(links.estimate('a','b','net2',100),undefined);
 assert.throws(()=>links.observe('a','b','net1','net1','REAL',{bytes:100,durationMs:1,observedAt:100}),/INVALID/);
});
