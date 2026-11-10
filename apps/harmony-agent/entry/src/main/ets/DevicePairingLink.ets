import { util } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import cert from '@ohos.security.cert';
import { common } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { Bootstrap, NativeTransport } from './NativePlatform';

export async function resolveDeviceInvitation(value:string,context:common.UIAbilityContext):Promise<Bootstrap>{
  const input=value.trim();
  if(input.startsWith('https://'))return resolveDevicePairingLink(input,'',context);
  const bootstrap=JSON.parse(input) as Bootstrap;
  if(!bootstrap.invitation||bootstrap.invitation.version!==2||!bootstrap.contribution)throw Error('INVITATION_INVALID');
  if(bootstrap.invitation.expiresAt<=Date.now())throw Error('INVITATION_EXPIRED');
  return bootstrap;
}

export async function resolveDevicePairingLink(value: string, selected: string,
  context: common.UIAbilityContext): Promise<Bootstrap> {
  const link = /^(https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?)\/#device=([a-f0-9-]{36})\.([A-Za-z0-9_-]{24})&pin=([a-f0-9]{64})$/.exec(value);
  if (!link) throw Error('设备配对链接格式不正确');
  const address = link[1];
  if (selected && selected !== address) throw Error('设备邀请与所选协调中心不一致');

  const request = http.createHttp();
  let certificate: string;
  try {
    // This request carries no invite or credentials. Its public response is untrusted
    // until NativeTransport checks it against the fingerprint from the QR.
    const response = await request.request(address + '/v2/pairing/certificate', {
      method: http.RequestMethod.GET, remoteValidation: 'skip', usingProxy: false,
      expectDataType: http.HttpDataType.STRING, usingCache: false,
      connectTimeout: 5000, readTimeout: 5000, maxLimit: 8192
    });
    if (response.responseCode !== 200 || typeof response.result !== 'string' ||
        response.result.length > 8192 || !response.result.startsWith('-----BEGIN CERTIFICATE-----')) {
      throw Error('无法读取协调中心公开证书');
    }
    certificate = response.result;
  } finally {
    request.destroy();
  }

  const transport = new NativeTransport({ address, certificate, fingerprint: link[4] }, context);
  await transport.initialize();
  const bootstrap = await transport.json('/v2/pairing/bootstrap', { inviteId: link[2], code: link[3] }) as Bootstrap;
  const invite = bootstrap.invitation;
  if (!invite || invite.address !== address || invite.inviteId !== link[2] ||
      invite.code !== link[3] || invite.fingerprint !== link[4]) {
    throw Error('协调中心返回的设备邀请与二维码不一致');
  }
  return bootstrap;
}

export interface PairingTrust {address:string;certificate:string;fingerprint:string;}
export async function readPairingTrust(value:string):Promise<PairingTrust>{
  const address=value.trim().replace(/\/$/,'');
  if(!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(address))throw Error('请选择或输入 HTTPS 协调中心地址');
  const request=http.createHttp();
  let certificate:string;
  try{
    const response=await request.request(address+'/v2/pairing/certificate',{
      method:http.RequestMethod.GET,remoteValidation:'skip',usingProxy:false,
      expectDataType:http.HttpDataType.STRING,usingCache:false,connectTimeout:5000,readTimeout:5000,maxLimit:8192
    });
    if(response.responseCode!==200||typeof response.result!=='string'||response.result.length>8192)throw Error('无法读取中心证书');
    certificate=response.result;
  }finally{request.destroy();}
  const parsed=await cert.createX509Cert({data:new util.TextEncoder().encodeInto(certificate),encodingFormat:cert.EncodingFormat.FORMAT_PEM});
  const encoded=await parsed.getEncoded();
  const md=cryptoFramework.createMd('SHA256');md.updateSync({data:encoded.data});
  const fingerprint=Array.from(md.digestSync().data).map((n:number):string=>n.toString(16).padStart(2,'0')).join('');
  return {address,certificate,fingerprint};
}
export async function resolvePairingCode(code:string,trust:PairingTrust,context:common.UIAbilityContext):Promise<Bootstrap>{
  if(!/^\d{6}$/.test(code))throw Error('请输入 6 位数字配对码');
  const transport=new NativeTransport(trust,context);await transport.initialize();
  const bootstrap=await transport.json('/v2/pairing/code',{code}) as Bootstrap;
  if(!bootstrap.invitation||bootstrap.invitation.version!==2||!bootstrap.contribution||
    bootstrap.invitation.expiresAt<=Date.now()||bootstrap.invitation.address!==trust.address||
    bootstrap.invitation.fingerprint!==trust.fingerprint)throw Error('中心身份不一致或设备邀请已过期');
  return bootstrap;
}
