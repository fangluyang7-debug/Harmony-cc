import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';
import { CoordinatorGrantSigner } from './CoordinatorAllotments';
import { AllotmentAckV2 } from '../protocol/ResourcesV2';
import { canonical } from '../core/CanonicalV2';
const encode=(value:string):Uint8Array=>new util.TextEncoder().encodeInto(value);
export class CoordinatorGrantCrypto implements CoordinatorGrantSigner {
 private key:cryptoFramework.PriKey;
 private constructor(key:cryptoFramework.PriKey){this.key=key;}
 static async create(pem:string):Promise<CoordinatorGrantCrypto>{
  const data=new util.Base64Helper().decodeSync(pem.replace(/-----[^-]+-----/g,'').replace(/\s/g,''));
  const pair=await cryptoFramework.createAsyKeyGenerator('RSA3072').convertKey(null,{data});return new CoordinatorGrantCrypto(pair.priKey);
 }
 async sign(payload:Object):Promise<string>{const signer=cryptoFramework.createSign('RSA3072|PKCS1|SHA256');await signer.init(this.key);return new util.Base64Helper().encodeToStringSync((await signer.sign({data:encode(canonical(payload))})).data);}
 async verifyAck(ack:AllotmentAckV2,tokenHash:string,signature:string):Promise<boolean>{
  if(!/^[a-f0-9]{64}$/.test(tokenHash)||!/^[A-Za-z0-9+/]{43}=$/.test(signature))return false;
  const data=new Uint8Array(32);for(let i=0;i<32;i++)data[i]=parseInt(tokenHash.slice(i*2,i*2+2),16);
  const key=await cryptoFramework.createSymKeyGenerator('HMAC|SHA256').convertKey({data});const mac=cryptoFramework.createMac('SHA256');mac.initSync(key);mac.updateSync({data:encode(canonical(ack))});
  const expected=(await mac.doFinal()).data,actual=new util.Base64Helper().decodeSync(signature);if(actual.length!==expected.length)return false;
  let difference=0;for(let i=0;i<actual.length;i++)difference|=actual[i]^expected[i];return difference===0;
 }
}
