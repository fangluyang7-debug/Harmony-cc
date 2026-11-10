// Independent photo App: credentials stay native; all computation uses the SDK.
const encode=bytes=>{let value='';for(let i=0;i<bytes.length;i+=32768)value+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(value);};
const decode=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
export function nativePhotoClient(bridge,group,digest){
 const clockDomainId='photo-app-'+crypto.randomUUID();
 const prefix='/v2/spaces/'+encodeURIComponent(group);
 function route(url){const value=String(url);if(!value.startsWith(prefix+'/photo-runs'))throw Error('PHOTO_ROUTE_INVALID');return value.slice(prefix.length);}
 async function request(url,options={}){
  const message={route:route(url),method:options.method||'GET'};
  if(message.method==='PUT')message.data=encode(options.body instanceof Uint8Array?options.body:new Uint8Array(options.body));
  else if(options.body!=null)message.body=JSON.parse(options.body);
  try{return new Response(await bridge.request(JSON.stringify(message)),{status:200,headers:{'Content-Type':'application/json'}});}
  catch(e){return new Response(JSON.stringify({error:e.message||String(e)}),{status:400,headers:{'Content-Type':'application/json'}});}
 }
 return {fetch:request,input:async url=>{const r=await request(url);if(!r.ok)throw Error((await r.json()).error);const value=await r.json();return 'data:'+value.mime+';base64,'+value.data;},port:()=>({
  request:(route,body)=>bridge.sdkRequest(route,body),
  write:(ticket,data)=>bridge.sdkWrite(JSON.stringify(ticket),encode(data)),
  read:async ticket=>decode(await bridge.sdkRead(JSON.stringify(ticket))),
  digest,now:Date.now,measure:()=>({clockDomainId,milliseconds:performance.now()}),wait:ms=>new Promise(r=>setTimeout(r,ms))
 })};
}
