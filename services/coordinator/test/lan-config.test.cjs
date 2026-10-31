const {test}=require('node:test'),assert=require('node:assert/strict'),os=require('node:os');
const {loadConfig}=require('../dist/config');
const {lanEnvironment}=require('../../../scripts/start-coordinator-lan.cjs');
test('LAN startup binds all interfaces but advertises a real interface matching its TLS certificate',()=>{
 assert.throws(()=>lanEnvironment('localhost'),/LAN_ADDRESS_REQUIRED/);
 const address=Object.values(os.networkInterfaces()).flat().find(i=>i&&!i.internal&&i.family==='IPv4')?.address;
 if(address){const env=lanEnvironment(address,'7443',undefined,{}),config=loadConfig(env);assert.equal(config.host,'0.0.0.0');assert.equal(config.certificateHost,address);assert.equal(config.publicUrl,`https://${address}:7443`);assert.equal(config.proxy,false);}
 assert.throws(()=>loadConfig({COORDINATOR_PUBLIC_URL:'https://192.168.1.2:7443'}),/PUBLIC_URL_CERTIFICATE_MISMATCH/);
 assert.equal(loadConfig({COORDINATOR_TLS_MODE:'proxy',COORDINATOR_PUBLIC_URL:'https://public.example'}).proxy,true);
});

test('coordinator accepts HTTPS on the LAN interface with an IP SAN (one host only)',async t=>{
 const address=Object.values(os.networkInterfaces()).flat().find(i=>i&&!i.internal&&i.family==='IPv4')?.address;
 if(!address){t.skip('no LAN IPv4 interface');return;}
 const {runtime}=require('./helpers.cjs'),https=require('node:https');
 const r=await runtime({}, {COORDINATOR_HOST:'0.0.0.0',COORDINATOR_CERTIFICATE_HOST:address});
 try{await new Promise((resolve,reject)=>{const q=https.get(r.url+'/v2/health/ready',{ca:r.identity.cert},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>{try{assert.equal(res.statusCode,200);assert.equal(JSON.parse(body).ready,true);resolve();}catch(e){reject(e);}});});q.on('error',reject);q.setTimeout(5000,()=>q.destroy(Error('LAN_TIMEOUT')));});}
 finally{await r.close();}
});
