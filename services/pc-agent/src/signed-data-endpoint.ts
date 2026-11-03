import https from 'node:https';
import {canonical} from '@harmony/scheduler-core';
import {ArtifactChannel, ArtifactDescriptor, ArtifactSchema, DataEndpointIdentity, SignedTransfer, transferDigest, verifyTransfer} from '@harmony/resource-transport';

/** Independent PC HTTPS service. Only short-lived transfer proofs are accepted here. */
export function createSignedDataEndpoint(config:{directory:string;domain:'REAL'|'SIMULATED';key:string;certificate:string;
  coordinatorCertificate:string;endpoint:()=>DataEndpointIdentity|null;schemas:ReadonlyMap<string,ArtifactSchema>;
  consume:(signed:SignedTransfer,proof:string)=>Promise<unknown>;
  receipt:(authorizationId:string,contentHash:string,bytes:number)=>Promise<unknown>;now?:()=>number}){
  const now=config.now??Date.now;
  const channel=new ArtifactChannel(config.directory,config.domain,async()=>{throw Error('LONG_TERM_CREDENTIAL_FORBIDDEN');},config.schemas,now);
  let active=0,probeWindow=0,probes=0;
  const server=https.createServer({key:config.key,cert:config.certificate,maxHeaderSize:16384},(request,response)=>{
    void (async()=>{
      if(active>=4){response.writeHead(429).end();return;}active++;
      try{
        if(request.headers['x-device-credential']!==undefined||request.headers.cookie!==undefined)throw Error('LONG_TERM_CREDENTIAL_FORBIDDEN');
        const probe=/^\/v2\/direct\/probe\?bytes=(1024|8192|32768)$/.exec(request.url??'');
        if(probe){
          const endpoint=config.endpoint();if(!endpoint||request.headers.authorization!==undefined||!['GET','PUT'].includes(request.method??''))throw Error('PROBE_INVALID');
          if(now()-probeWindow>=1000){probeWindow=now();probes=0;}if(++probes>16)throw Error('PROBE_RATE_LIMIT');
          const count=Number(probe[1]);
          if(request.method==='PUT'){
            if(request.headers['content-length']!==String(count))throw Error('PROBE_SIZE');
            let size=0;request.setTimeout(3000,()=>request.destroy());for await(const chunk of request){size+=chunk.length;if(size>count)throw Error('PROBE_SIZE');}if(size!==count)throw Error('PROBE_SIZE');
          }
          response.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':request.method==='GET'?count:0,'X-Endpoint-Epoch':endpoint.epoch,'Cache-Control':'no-store'}).end(request.method==='GET'?Buffer.alloc(count):undefined);return;
        }
        const auth=request.headers.authorization,proof=request.headers['x-transfer-proof'];
        if(typeof auth!=='string'||!auth.startsWith('Transfer ')||auth.length>12000||typeof proof!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(proof))throw Error('TRANSFER_PROOF_INVALID');
        const signed:SignedTransfer=JSON.parse(Buffer.from(auth.slice(9),'base64url').toString('utf8'));
        const a=verifyTransfer(signed,config.coordinatorCertificate,config.domain,now()),endpoint=config.endpoint();
        if(!endpoint||canonical(endpoint)!==canonical(a.endpoint)||transferDigest(proof)!==a.proofHash||request.url!=='/v2/direct/'+a.id||
          request.method!==(a.operation==='WRITE'?'PUT':'GET'))throw Error('TRANSFER_ENDPOINT_SCOPE');
        if(a.operation==='WRITE'&&(request.headers['content-length']!==String(a.bytes)||request.headers['content-type']!=='application/octet-stream'))throw Error('TRANSFER_SIZE');
        await config.consume(signed,proof); // An ambiguous response burns the grant; never retry it as a new execution.
        const descriptor:ArtifactDescriptor={ref:a.ref,groupId:a.groupId,ownerPrincipalId:a.ownerPrincipalId,bytes:a.bytes,expiresAt:a.expiresAt,domain:a.domain};
        if(a.operation==='READ'){
          const cached=channel.lookup(a.groupId,a.ref);if(!cached||cached.ownerPrincipalId!==a.ownerPrincipalId||cached.bytes!==a.bytes)throw Error('TRANSFER_CACHE_MISSING');
          const bytes=await channel.readForControl(cached);response.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes.length,'Cache-Control':'no-store'}).end(bytes);return;
        }
        let size=0;const chunks:Buffer[]=[];request.setTimeout(10000,()=>request.destroy());
        for await(const chunk of request){size+=chunk.length;if(size>a.bytes)throw Error('TRANSFER_SIZE');chunks.push(Buffer.from(chunk));}
        const bytes=Buffer.concat(chunks);if(size!==a.bytes||transferDigest(bytes)!==a.ref.contentHash)throw Error('TRANSFER_HASH');
        // A stable cache descriptor is separate from the single-use authorization lifetime.
        const cached=channel.lookup(a.groupId,a.ref);
        if(cached){if(cached.ownerPrincipalId!==a.ownerPrincipalId||cached.bytes!==a.bytes)throw Error('TRANSFER_CACHE_SCOPE');}
        else channel.register({...descriptor,expiresAt:a.artifactExpiresAt??now()+3600000});
        await channel.writeForControl(cached??channel.lookup(a.groupId,a.ref)!,bytes);
        await config.receipt(a.id,a.ref.contentHash,a.bytes);
        response.writeHead(201,{'Cache-Control':'no-store'}).end();
      }catch{if(!response.headersSent)response.writeHead(403);response.end();}
      finally{active--;}
    })();
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,channel};
}
