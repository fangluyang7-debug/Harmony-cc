import { common } from '@kit.AbilityKit';
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { ConsoleConnection, consoleOrigin } from './ConsoleConnection';
export interface JoinInvitation { connection:ConsoleConnection; code:string; }
export function parseJoinInvitation(value:string):JoinInvitation {
 const input=value.trim(),parts=input.split('/#');
 if(parts.length!==2)throw Error('请粘贴负责人分享的完整接入密钥。');
 const address=consoleOrigin(parts[0]);let code='',fingerprint='';
 for(const part of parts[1].split('&')){const pair=part.split('=');if(pair[0]==='join')code=decodeURIComponent(pair[1]??'');if(pair[0]==='pin')fingerprint=pair[1]??'';}
 if(!/^[A-Za-z0-9_-]{24}$/.test(code)||(fingerprint!==''&&!/^[a-f0-9]{64}$/.test(fingerprint)))throw Error('接入密钥格式不正确。');
 return {connection:{address,groupId:'',fingerprint},code};
}
export async function scanJoinInvitation(context:common.UIAbilityContext):Promise<string>{
 const result=await scanBarcode.startScanForResult(context,{scanTypes:[scanCore.ScanType.QR_CODE],enableMultiMode:false,enableAlbum:true});
 parseJoinInvitation(result.originalValue);return result.originalValue;
}
/** The connection home accepts both member invitations and the center's device-pairing links. */
export async function scanConnectionInvitation(context:common.UIAbilityContext):Promise<string>{
 const result=await scanBarcode.startScanForResult(context,{scanTypes:[scanCore.ScanType.QR_CODE],enableMultiMode:false,enableAlbum:true});
 if(!result.originalValue.includes('/#device='))parseJoinInvitation(result.originalValue);
 return result.originalValue;
}
