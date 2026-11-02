// Separate process, independent endpoint key. The coordinator private key is never supplied.
const {openDataHost}=require('../../pc-agent/dist/data-host');
const {directTransfer,pinOptions}=require('@harmony/resource-transport');
const https=require('node:https');
const {cpuSchemas}=require('@harmony/reference-capabilities');
let host,connection;
process.on('message',async message=>{
 try{
  let value;
  if(message.action==='open'){
   connection=message.connection;host=await openDataHost(message.directory,connection,{listenHost:'127.0.0.1',advertisedHost:'127.0.0.1'},cpuSchemas);
   value={endpoint:host.identity(),pid:process.pid};
  }else if(message.action==='send'){
   const result=await directTransfer(message.grant,connection.certificate,connection.domain,Buffer.from(message.bytes,'base64'));
   value={durationMs:result.durationMs};
  }else if(message.action==='long-term-header'){
   const a=message.grant.signed.authorization;
   value=await new Promise((resolve,reject)=>{
    const request=https.request(new URL('/v2/direct/'+a.id,a.endpoint.address),{...pinOptions(a.endpoint),method:'PUT',headers:{Authorization:'Transfer '+Buffer.from(JSON.stringify(message.grant.signed)).toString('base64url'),'X-Transfer-Proof':message.grant.proof,'X-Device-Credential':'forbidden-fixture-value','Content-Type':'application/octet-stream','Content-Length':a.bytes}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});
    request.on('error',reject);request.setTimeout(3000,()=>request.destroy(Error('RAW_REQUEST_TIMEOUT')));request.end(Buffer.from(message.bytes,'base64'));
   });
  }else if(message.action==='read-cache'){
   const d=host.channel.lookup(message.groupId,message.ref);value=d?(await host.channel.readForControl(d)).toString('base64'):null;
  }else if(message.action==='register'){
   await host.register();value=host.identity();
  }else if(message.action==='close'){
   await host?.close();host=undefined;value=true;
  }else throw Error('FIXTURE_ACTION_INVALID');
  process.send({id:message.id,value});
 }catch(error){process.send({id:message.id,error:error.message});}
});
process.on('disconnect',()=>{void host?.close().finally(()=>process.exit(0));if(!host)process.exit(0);});
