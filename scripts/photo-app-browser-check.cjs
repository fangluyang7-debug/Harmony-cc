// Local browser substitute for the native bridge. Real SDK HTTP, CPU model and
// receipts; this is not Harmony hardware or a performance comparison.
const https=require('node:https'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
module.exports=async({r,paired,group,url,root,api})=>{
 const contracts=['photo.analyze.v1','photo.prepare.v1','photo.enhance.v1','photo.assemble.v1','photo.deliver.v1'];
 const registration=await r.apps.register(paired.peer,{label:'Photo isolated integration',allowedContracts:contracts,maxConcurrent:4,resources:[{resourcePoolId:'cpu',amount:2},{resourcePoolId:'ram',amount:2147483648}],offlineBase:[],onlineExtra:[]},r.url);
 const app=await r.apps.exchange({registrationId:registration.registrationId,code:registration.code});
 const request=(route,method,body,headers={})=>new Promise((resolve,reject)=>{
  const req=https.request(r.url+route,{ca:r.identity.cert,method,headers:{Authorization:'Bearer '+app.credential,...headers}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{const b=Buffer.concat(chunks);if(res.statusCode>=400){let e;try{e=JSON.parse(b).error;}catch{e='HTTP '+res.statusCode;}reject(Error(e));}else resolve(b);});});req.on('error',reject);req.end(body);
 });
 const json=(route,body)=>request(route,body==null?'GET':'POST',body==null?undefined:body,{'Content-Type':'application/json'}).then(b=>b.toString());
 const {chromium}=require(path.join(root,'.test/photo-ui/node_modules/playwright'));
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const directory=path.join(root,'.test/photo-tools/independent-app');fs.mkdirSync(directory,{recursive:true});
 try{
  const mobile=await browser.newPage({viewport:{width:390,height:844}}),judge=await browser.newPage({viewport:{width:1600,height:1050}}),errors=[];
  mobile.on('pageerror',e=>errors.push(e.message));judge.on('pageerror',e=>errors.push(e.message));
  // Generated after the empty execution host is ready; never installed in it.
  const input=await require('sharp')({create:{width:72,height:16,channels:3,background:{r:127,g:74,b:31}}}).png().toBuffer();
  await mobile.exposeFunction('photoTestBridge',async(method,args)=>{
   if(method==='info')return JSON.stringify({deviceId:paired.peer.deviceId,groupId:group});
   if(method==='pickPhoto')return JSON.stringify({name:'local-integration.png',mime:'image/png',data:input.toString('base64')});
   if(method==='request')return json('/v2/apps/photo',args[0]);
   if(method==='sdkRequest')return json(args[0],args[1]);
   const ticket=JSON.parse(args[0]);assert.equal(ticket.direct,undefined,'This rehearsal must use the relay transport');
   const route='/v2/artifacts/'+ticket.ref.artifactId+'/'+ticket.ref.contentVersion,headers={Authorization:'Bearer '+ticket.token,'X-Device-Credential':app.credential,'Content-Type':'application/octet-stream'};
   if(method==='sdkWrite'){await request(route,'PUT',Buffer.from(args[1],'base64'),headers);return;}
   if(method==='sdkRead')return (await request(route,'GET',undefined,headers)).toString('base64');
   throw Error('UNKNOWN_BRIDGE_METHOD');
  });
  await mobile.addInitScript(()=>{window.harmonyPhoto=Object.fromEntries(['info','pickPhoto','request','sdkRequest','sdkWrite','sdkRead'].map(m=>[m,(...args)=>window.photoTestBridge(m,args)]));});
  await mobile.goto(url.replace('/photo.html?','/photo-mobile.html?')+'&app=photo');
  await mobile.waitForFunction(()=>!document.querySelector('#native-pick').hidden);
  assert.equal(await mobile.locator('.live-plan').isVisible(),false);assert.equal(await mobile.locator('#watch').isVisible(),false);
  await mobile.click('#native-pick');await mobile.selectOption('#mode','LOCAL');
  await mobile.screenshot({path:path.join(directory,'phone-ready.png'),fullPage:true});
  await judge.goto(url+'&view=judge');await mobile.click('#run');
  await judge.waitForFunction(()=>document.querySelectorAll('.node').length>0,{},{timeout:60000});
  await judge.screenshot({path:path.join(directory,'desktop-running.png'),fullPage:true});
  await mobile.waitForFunction(()=>!document.querySelector('#run').disabled,{},{timeout:240000});
  assert.equal(await mobile.locator('#state').innerText(),'全部结果已交付',await mobile.locator('#error').innerText());
  await judge.waitForFunction(()=>document.querySelector('#preview img'),{},{timeout:15000});
  await mobile.waitForFunction(()=>document.querySelector('#preview img'),{},{timeout:15000});
  assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Mobile layout overflow');
  await mobile.screenshot({path:path.join(directory,'phone-result.png'),fullPage:true});
  await judge.screenshot({path:path.join(directory,'desktop-result.png'),fullPage:true});
  const records=await api('/'+group+'/photo-runs'),evidence=await api('/'+group+'/photo-runs/'+records[0].id);
  assert.equal(evidence.appInstanceId,app.peer.app.appInstanceId);assert.equal(evidence.allCommitted,true);
  const attempts=await r.db.attempt.findMany({where:{workflowId:{in:evidence.jobs.map(j=>j.id)}}}),stages=evidence.workflows.reduce((n,w)=>n+w.nodes.length,0);
  assert.equal(attempts.length,stages);assert.equal(new Set(attempts.map(a=>a.workflowId+':'+a.nodeId)).size,stages);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(directory,'evidence.json'),JSON.stringify({kind:'LOCAL_PROCESS_TEST_NATIVE_BRIDGE_SUBSTITUTE',...evidence},null,2));
  console.log('PHOTO_INDEPENDENT_APP_PASSED',stages,'committed stages; phone controls and desktop judge');
 }finally{await browser.close();}
};
