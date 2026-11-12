const {test}=require('node:test'),assert=require('node:assert/strict');
const {discoveryInterfaces}=require('../../apps/windows-agent/discovery.cjs');
test('discovery addresses each active IPv4 subnet separately, including WLAN with virtual adapters',()=>{
 const got=discoveryInterfaces({wsl:[{family:'IPv4',address:'172.27.32.1',netmask:'255.255.240.0',internal:false}],wlan:[{family:'IPv4',address:'192.168.104.42',netmask:'255.255.255.0',internal:false}],lo:[{family:'IPv4',address:'127.0.0.1',netmask:'255.0.0.0',internal:true}],v6:[{family:'IPv6',address:'::1',netmask:'ffff',internal:false}]});
 assert.deepEqual(got,[{address:'172.27.32.1',broadcast:'172.27.47.255'},{address:'192.168.104.42',broadcast:'192.168.104.255'}]);
});
