const {test}=require('node:test'),assert=require('node:assert/strict'),https=require('node:https'),crypto=require('node:crypto');
const {runtime}=require('./helpers.cjs');
test('space event stream authenticates members, delivers mutation hints and closes on logout',async()=>{
 const r=await runtime();let cookie='',stream;
 const request=(route,body)=>new Promise((resolve,reject)=>{
  const q=https.request(r.url+'/v2/spaces'+route,{ca:r.identity.cert,method:body?'POST':'GET',headers:{Cookie:cookie,'Content-Type':'application/json'}},res=>{
   if(res.headers['set-cookie'])cookie=res.headers['set-cookie'][0].split(';')[0];let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
  });q.on('error',reject);q.end(body?JSON.stringify(body):undefined);
 });
 try{
  assert.equal((await request('/unknown/events')).status,401);
  await request('/register',{account:crypto.randomUUID(),name:'test',password:'test-password'});
  assert.equal((await request('/unknown/events')).status,403);
  const id=(await request('/',{name:'events'})).body.id;
  let count=0,ended=false;
  await new Promise((resolve,reject)=>{stream=https.get(r.url+'/v2/spaces/'+id+'/events',{ca:r.identity.cert,headers:{Cookie:cookie}},res=>{
   assert.equal(res.statusCode,200);assert.match(res.headers['content-type'],/text\/event-stream/);
   res.on('data',b=>{count+=(b.toString().match(/event: changed/g)||[]).length;if(count)resolve();});res.on('end',()=>ended=true);
  });stream.on('error',reject);});
  const initial=count;await request('/'+id+'/invites',{role:'VIEWER'});
  const wait=async check=>{const end=Date.now()+4000;while(!check()){assert.ok(Date.now()<end,'event timeout');await new Promise(r=>setTimeout(r,10));}};
  await wait(()=>count>initial);
  await request('/logout',{});
  await wait(()=>ended);
 }finally{stream?.destroy();await r.close();}
});
