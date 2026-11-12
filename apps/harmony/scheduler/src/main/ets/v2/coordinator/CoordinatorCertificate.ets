import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';

function join(parts:Uint8Array[]):Uint8Array {const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;}
function der(tag:number,value:Uint8Array):Uint8Array {const length:number[]=[];let n=value.length;if(n<128)length.push(n);else{while(n>0){length.unshift(n&255);n=Math.floor(n/256);}length.unshift(128+length.length);}return join([new Uint8Array([tag,...length]),value]);}
function seq(parts:Uint8Array[]):Uint8Array{return der(48,join(parts));}
function oid(value:number[]):Uint8Array{return der(6,new Uint8Array(value));}
function encoded(value:string):Uint8Array{return new util.TextEncoder().encodeInto(value);}
function name(value:string):Uint8Array{return seq([der(49,seq([oid([85,4,3]),der(12,encoded(value))]))]);}
function date(value:Date):Uint8Array {return der(24,encoded(value.toISOString().replace(/[-:]/g,'').replace('T','').slice(0,14)+'Z'));}
function pem(label:string,data:Uint8Array):string{const b64=new util.Base64Helper().encodeToStringSync(data),lines:string[]=[];for(let i=0;i<b64.length;i+=64)lines.push(b64.slice(i,i+64));return '-----BEGIN '+label+'-----\n'+lines.join('\n')+'\n-----END '+label+'-----\n';}
export interface CoordinatorCertificate {certificate:string;privateKey:string;fingerprint:string;}
/** Generate a device-local identity; no development private key is shipped in the HAP. */
export async function createCoordinatorCertificate(ipAddresses:string[]):Promise<CoordinatorCertificate>{
 const addresses=Array.from(new Set<string>(['127.0.0.1',...ipAddresses]));
 for(const address of addresses)if(!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)||address.split('.').some(n=>Number(n)>255))throw Error('CERTIFICATE_ADDRESS_INVALID');
 const pair=await cryptoFramework.createAsyKeyGenerator('RSA3072').generateKeyPair();
 const algorithm=seq([oid([42,134,72,134,247,13,1,1,11]),der(5,new Uint8Array(0))]);
 const serial=cryptoFramework.createRandom().generateRandomSync(16).data;serial[0]&=127;serial[0]|=1;
 const issuer=name('Harmony Coordinator');
 const san:Uint8Array[]=[der(130,encoded('localhost'))];
 for(const address of addresses)san.push(der(135,new Uint8Array(address.split('.').map(n=>Number(n)))));
 const extensions=der(163,seq([seq([oid([85,29,17]),der(4,seq(san))])]));
 const now=Date.now(),tbs=seq([der(160,der(2,new Uint8Array([2]))),der(2,serial),algorithm,issuer,seq([date(new Date(now-300000)),date(new Date(now+365*86400000))]),issuer,pair.pubKey.getEncoded().data,extensions]);
 const signer=cryptoFramework.createSign('RSA3072|PKCS1|SHA256');await signer.init(pair.priKey);const signature=await signer.sign({data:tbs});
 const certificate=seq([tbs,algorithm,der(3,join([new Uint8Array([0]),signature.data]))]);
 const digest=cryptoFramework.createMd('SHA256');digest.updateSync({data:certificate});
 return {certificate:pem('CERTIFICATE',certificate),privateKey:pem('PRIVATE KEY',pair.priKey.getEncoded().data),fingerprint:Array.from(digest.digestSync().data).map(n=>n.toString(16).padStart(2,'0')).join('')};
}
