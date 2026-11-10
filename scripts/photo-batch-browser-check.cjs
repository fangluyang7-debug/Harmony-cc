// Real local batch smoke test. Photos are prepared at the source after workers
// are ready. No task photos or results are installed in worker payloads.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),sharp=require('sharp');
const root=path.resolve(__dirname,'..'),{chromium}=require(path.join(root,'.test/photo-ui/node_modules/playwright'));
async function main(){
 const r=JSON.parse(fs.readFileSync(path.join(root,'.test/photo-tools/rehearsal.json'))),browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1600,height:1050}}),judge=await browser.newPage({viewport:{width:1600,height:1050}}),errors=[];
  for(const p of [page,judge])p.on('pageerror',e=>errors.push(e.message));
  await page.goto(r.url);await judge.goto(r.url+'&view=judge');
  const source=path.join(root,'.test/photo-tools/realesrgan/input2.jpg'),metadata=await sharp(source).metadata();
  const names=['海岸全景','远山与海','岸边浪花','海湾一角','沙滩光影','蓝色海面'],files=[];
  for(let i=0;i<6;i++){
   const left=(i%3)*Math.floor(metadata.width/8),top=Math.floor(i/3)*Math.floor(metadata.height/5),width=Math.floor(metadata.width/2),height=Math.floor(metadata.height/2);
   const buffer=await sharp(source).extract({left,top,width,height}).resize(96,64).png().toBuffer();
   files.push({name:names[i]+'.png',mimeType:'image/png',buffer});
  }
  await page.locator('#files').setInputFiles(files);
  assert.equal(await page.locator('#source-gallery img').count(),6);assert.equal(await page.locator('#preview img').count(),0);
  const previous=await judge.locator('#run-id').textContent();await page.click('#run');
  await judge.waitForFunction(old=>document.querySelector('#run-id').textContent!==old&&document.querySelectorAll('#source-gallery img').length===6&&document.querySelector('#run-summary').hidden,previous,{timeout:30000});
  assert.equal(await judge.locator('#run-summary').isVisible(),false);
  await judge.screenshot({path:path.join(root,'.test/photo-tools/batch-start.png'),fullPage:true});
  await judge.waitForFunction(()=>{const n=document.querySelectorAll('.result-photo').length;return n>0&&n<6;},{},{timeout:180000});
  const first={visible:await judge.locator('.result-photo').count(),summaryHidden:!await judge.locator('#run-summary').isVisible(),sourceStillRunning:!await page.locator('#run').isEnabled()};
  assert.equal(first.summaryHidden,true);assert.equal(first.sourceStillRunning,true);console.log('PARTIAL_DELIVERY',JSON.stringify(first));
  await judge.screenshot({path:path.join(root,'.test/photo-tools/batch-live.png'),fullPage:true});
  await page.waitForFunction(()=>!document.querySelector('#run').disabled,{},{timeout:240000});
  assert.equal(await page.locator('#state').innerText(),'全部结果已交付',await page.locator('#error').innerText());
  await judge.waitForFunction(()=>document.querySelectorAll('.result-photo').length===6&&!document.querySelector('#run-summary').hidden,{},{timeout:20000});
  await judge.screenshot({path:path.join(root,'.test/photo-tools/batch-complete.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(root,'.test/photo-tools/batch-mobile.png'),fullPage:true});assert.deepEqual(errors,[]);
  const base=new URL(r.url).origin+'/v2/spaces/'+r.group+'/photo-runs',runs=await(await fetch(base)).json(),evidence=await(await fetch(base+'/'+runs[0].id)).json();
  assert.equal(evidence.allCommitted,true);assert.equal(evidence.images.filter(i=>i.delivered).length,6);assert.equal(evidence.budgetMs,180000);
  const {PrismaClient}=require('../services/coordinator/generated/client'),db=new PrismaClient({datasources:{db:{url:'file:'+path.join(r.dataDir,'coordinator.sqlite').replaceAll('\\','/')}}});
  let attempts;try{attempts=await db.attempt.findMany({where:{workflowId:{in:evidence.jobs.map(j=>j.id)}}});}finally{await db.$disconnect();}
  const nodes=evidence.workflows.flatMap(w=>w.nodes);assert.equal(attempts.length,nodes.length);assert.equal(new Set(attempts.map(a=>a.workflowId+':'+a.nodeId)).size,nodes.length);
  fs.writeFileSync(path.join(root,'.test/photo-tools/batch-evidence.json'),JSON.stringify({kind:'LOCAL_PROCESS_TEST',inputNote:'Six 96x64 source-side crops of the distribution beach photo; correctness check, not a full-size performance benchmark',first,...evidence},null,2));
  console.log('PHOTO_BATCH_PASSED',JSON.stringify({images:6,nodes:nodes.length,milliseconds:evidence.sourceDurationMs}));
 }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
