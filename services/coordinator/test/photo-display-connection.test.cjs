const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {photoDisplayConnection}=require('../dist/photo-display-connection');
test('display bridge reads only loopback session and rejects incorrect public host or protocol',async t=>{
 let value={displayOnly:true,invitation:'http://192.168.1.2:7460/#display='+'a'.repeat(36)},requests=[];
 const server=http.createServer((req,res)=>{requests.push(req.url);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const port=server.address().port;
 assert.deepEqual(await photoDisplayConnection('https://192.168.1.2:7443',port),value);
 await assert.rejects(photoDisplayConnection('https://192.168.1.3:7443',port),/UNAVAILABLE/);
 value.displayOnly=false;await assert.rejects(photoDisplayConnection('https://192.168.1.2:7443',port),/UNAVAILABLE/);
 assert.ok(requests.every(p=>p==='/session'));
});
