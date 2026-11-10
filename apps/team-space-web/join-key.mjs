// Member keys carry no device credential. A full key also carries the coordinator pin.
export function parseJoinKey(value,origin){
 const input=String(value??'').trim();
 const digits=input.replace(/[\s-]/g,'');
 if(/^\d{8}$/.test(digits)||/^[A-Za-z0-9_-]{24}$/.test(input)){
  if(!origin)throw Error('首次连接协调中心，请使用完整邀请链接；连接后即可使用 8 位加入码。');
  return {address:origin,code:/^\d{8}$/.test(digits)?digits:input,fingerprint:''};
 }
 let u;try{u=new URL(input);}catch{throw Error('请输入 8 位数字加入码或完整邀请链接。');}
 const p=new URLSearchParams(u.hash.slice(1)),code=p.get('join'),fingerprint=p.get('pin')||'';
 if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||!code||!/^[A-Za-z0-9_-]{24}$/.test(code)||fingerprint&&!/^[a-f0-9]{64}$/.test(fingerprint))throw Error('接入密钥格式不正确，请重新复制。');
 return {address:u.origin,code,fingerprint};
}
