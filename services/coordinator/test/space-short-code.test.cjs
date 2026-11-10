const {test}=require('node:test'),assert=require('node:assert/strict'),https=require('node:https'),crypto=require('node:crypto');
const {runtime}=require('./helpers.cjs');
function browser(r){let cookie='';return (route,body)=>new Promise((resolve,reject)=>{const data=body===undefined?null:Buffer.from(JSON.stringify(body));const q=https.request(r.url+'/v2/spaces'+route,{ca:r.identity.cert,method:data?'POST':'GET',headers:{Cookie:cookie,...(data?{'Content-Type':'application/json','Content-Length':data.length}:{})}},res=>{if(res.headers['set-cookie'])cookie=res.headers['set-cookie'][0].split(';')[0];const parts=[];res.on('data',p=>parts.push(p));res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(parts))});}catch(e){reject(e);}});});q.on('error',reject);q.end(data);});}
test('eight-digit aliases join the intended space, preserve roles, expiry and existing full-link tokens',async()=>{
 const r=await runtime(),owner=browser(r),guest=browser(r),legacy=browser(r),outsider=browser(r);
 try{
  for(const b of [owner,guest,legacy,outsider])assert.equal((await b('/register',{account:crypto.randomUUID(),name:'test',password:'test-password-123'})).status,200);
  const group=(await owner('/',{name:'short code test'})).body.id,other=(await owner('/',{name:'other'})).body.id;
  const a=await owner('/'+group+'/invites',{role:'VIEWER'}),b=await owner('/'+other+'/invites',{role:'MEMBER'});
  assert.equal(a.status,200);assert.match(a.body.shortCode,/^\d{8}$/);assert.equal(a.body.code.length,24);assert.notEqual(a.body.shortCode,b.body.shortCode);
  const spaced=a.body.shortCode.slice(0,4)+' '+a.body.shortCode.slice(4);
  assert.equal((await guest('/join',{code:spaced})).body.id,group);
  assert.equal((await guest('/join',{code:spaced.replace(' ','-')})).body.id,group);
  assert.equal((await guest('/'+group)).body.me.role,'VIEWER');
  assert.equal((await guest('/'+other)).status,403);
  assert.equal((await legacy('/join',{code:a.body.code})).body.id,group);
  assert.equal((await owner('/'+group)).body.members.length,3);
  assert.equal((await guest('/'+group+'/invites',{role:'MEMBER'})).status,403);
  const key=crypto.createHash('sha256').update(b.body.shortCode).digest('hex');
  await r.db.spaceInvite.update({where:{id:key},data:{expiresAt:Date.now()-1}});
  assert.equal((await outsider('/join',{code:b.body.shortCode})).body.error,'INVITE_EXPIRED');
  await r.db.spaceInvite.update({where:{id:key},data:{expiresAt:Date.now()+60000,revoked:true}});
  assert.equal((await outsider('/join',{code:b.body.shortCode})).body.error,'INVITE_EXPIRED');
  assert.equal((await outsider('/join',{code:'123'})).body.error,'INVITE_EXPIRED');
 }finally{await r.close();}
});
