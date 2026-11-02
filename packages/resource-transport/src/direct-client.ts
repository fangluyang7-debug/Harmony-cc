import https from 'node:https';
import {performance} from 'node:perf_hooks';
import {pinOptions} from './index';
import {SignedTransfer,transferDigest,verifyTransfer} from './signed-transfer';

/** Credential-free peer request. The authenticated coordinator delivered both signed plan and short-lived proof. */
export async function directTransfer(input:{signed:SignedTransfer;proof:string},coordinatorCertificate:string,domain:'REAL'|'SIMULATED',bytes?:Buffer,now=Date.now()){
  const a=verifyTransfer(input.signed,coordinatorCertificate,domain,now);
  if(typeof input.proof!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.proof)||transferDigest(input.proof)!==a.proofHash||
    (a.operation==='WRITE'?(!bytes||bytes.length!==a.bytes||transferDigest(bytes)!==a.ref.contentHash):bytes!==undefined))throw Error('TRANSFER_INPUT_INVALID');
  const started=performance.now(),endpoint=a.endpoint;
  return new Promise<{bytes:Buffer;durationMs:number}>((resolve,reject)=>{
    const request=https.request(new URL('/v2/direct/'+a.id,endpoint.address),{...pinOptions(endpoint),method:a.operation==='WRITE'?'PUT':'GET',
      headers:{Authorization:'Transfer '+Buffer.from(JSON.stringify(input.signed)).toString('base64url'),'X-Transfer-Proof':input.proof,
        ...(bytes?{'Content-Type':'application/octet-stream','Content-Length':bytes.length}:{})}},response=>{
      const chunks:Buffer[]=[];let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>(a.operation==='READ'?a.bytes:0)){request.destroy(Error('TRANSFER_SIZE'));return;}chunks.push(Buffer.from(chunk));});
      response.on('error',reject);response.on('end',()=>{
        if(response.statusCode!==(a.operation==='READ'?200:201)){reject(Error('TRANSFER_REJECTED'));return;}
        const data=Buffer.concat(chunks);if(a.operation==='READ'&&(data.length!==a.bytes||transferDigest(data)!==a.ref.contentHash)){reject(Error('TRANSFER_HASH'));return;}
        resolve({bytes:data,durationMs:performance.now()-started});
      });
    });
    const timer=setTimeout(()=>request.destroy(Error('TRANSFER_TIMEOUT')),10000);timer.unref();
    request.on('close',()=>clearTimeout(timer));request.on('error',reject);request.end(bytes);
  });
}
