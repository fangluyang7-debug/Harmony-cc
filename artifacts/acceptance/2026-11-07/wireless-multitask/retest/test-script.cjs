// Real-device verification through the existing space-scoped SchedulerSdk API.
// Usage: node scripts/test-wireless-multitask.cjs <https-origin> <private-session.json> <ca.crt> <output-directory>
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto'),{performance}=require('node:perf_hooks');
const {SchedulerSdk}=require('@harmony/scheduler-client'),sharp=require('sharp');
const [origin,sessionFile,certificateFile,outputDirectory]=process.argv.slice(2);
if(!origin||!sessionFile||!certificateFile||!outputDirectory)throw Error('ARGUMENTS_REQUIRED');
const session=JSON.parse(fs.readFileSync(sessionFile)),ca=fs.readFileSync(certificateFile),base=origin+'/v2/spaces/'+encodeURIComponent(session.group),dir=path.resolve(outputDirectory);
if(new URL(origin).protocol!=='https:')throw Error('HTTPS_REQUIRED');
fs.mkdirSync(dir,{recursive:true});
const digest=b=>createHash('sha256').update(b).digest('hex');
function request(route,method='GET',body=null,binary=false){return new Promise((resolve,reject)=>{
 const bytes=body===null?null:Buffer.from(body),req=https.request(base+route,{ca,method,headers:{Cookie:session.cookie,...(bytes?{'Content-Type':binary?'application/octet-stream':'application/json','Content-Length':bytes.length}:{})}},res=>{
  const parts=[];res.on('data',b=>parts.push(b));res.on('error',reject);res.on('end',()=>{const result=Buffer.concat(parts);if(res.statusCode!==200){let code='HTTP_'+res.statusCode;try{code=JSON.parse(result).error??code;}catch{}reject(Error(code));}else resolve(result);});
 });req.on('error',reject);req.setTimeout(15000,()=>req.destroy(Error('REQUEST_TIMEOUT')));req.end(bytes);
});}
const clockDomainId=randomUUID(),sdk=new SchedulerSdk({
 request:async(route,body)=>(await request(route.replace('/v2/sdk','/sdk'),body===null?'GET':'POST',body)).toString(),
 write:async(ticket,bytes)=>{await request('/sdk/jobs/'+encodeURIComponent(ticket.ref.artifactId.slice(3))+'/input','PUT',bytes,true);},
 read:ticket=>request('/sdk/jobs/'+encodeURIComponent(ticket.ref.artifactId.slice(4))+'/output'),
 digest:async bytes=>digest(bytes),now:Date.now,measure:()=>({clockDomainId,milliseconds:performance.now()}),wait:ms=>new Promise(r=>setTimeout(r,ms))
});
const report={startedAt:new Date().toISOString(),domain:'REAL',coordinator:origin,status:'RUNNING',samples:[],note:'Correctness and delivery checks; not a speedup comparison. Windows local execution does not cross Wi-Fi.'};
const save=()=>fs.writeFileSync(path.join(dir,'RESULTS.json'),JSON.stringify(report,null,2));
async function cases(){
 const texts=['无线 LAN 😀\r\nThree devices work together\n',Array.from({length:400},(_,i)=>'Record '+i+' 资源协同 CPU').join('\n')];
 const textCases=texts.map((text,i)=>({id:'text-'+i,capability:'text.count.v1',schema:'text.input',outputContract:'text.counts',input:Buffer.from(JSON.stringify({text})),parameters:{},verify:async output=>{
  const actual=JSON.parse(output),expected={characters:[...text].length,words:(text.match(/\S+/gu)||[]).length,lines:text.split(/\r\n|\r|\n/u).length};assert.deepEqual(actual,expected);return actual;
 }}));
 const vectors=[{dimension:2,rows:[[3,4],[0,0],[-5,12],[1e200,-1e200]]},{dimension:4,rows:Array.from({length:4096},(_,i)=>[i%97-48,i%31-15,i%11+1,i%7-3])}];
 const vectorCases=vectors.map((v,i)=>({id:'vector-'+i,capability:'vector.normalize.v1',schema:'vector.input',outputContract:'vector.normalized',input:Buffer.from(JSON.stringify(v)),parameters:{},verify:async output=>{
  const actual=JSON.parse(output);assert.equal(actual.dimension,v.dimension);assert.equal(actual.rows.length,v.rows.length);assert.equal(actual.norms.length,v.rows.length);let maxError=0;
  v.rows.forEach((row,k)=>{const norm=Math.hypot(...row);assert.ok(Number.isFinite(actual.norms[k]));assert.ok(Math.abs(actual.norms[k]-norm)<=1e-10*Math.max(1,norm));assert.equal(actual.rows[k].length,v.dimension);row.forEach((value,c)=>{const error=Math.abs(actual.rows[k][c]-(norm?value/norm:0));assert.ok(Number.isFinite(error)&&error<=1e-10);maxError=Math.max(maxError,error);});});return {dimension:v.dimension,rows:v.rows.length,maxAbsoluteComponentError:maxError};
 }}));
 // The crop contract expands to a square before resizing. Square quadrants
 // make the independent solid-color expectation valid on all backends.
 const width=1024,height=1024,raw=Buffer.alloc(width*height*3),colors=[[255,0,0],[0,255,0],[0,0,255],[255,255,0]];
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const color=colors[(y>=height/2?2:0)+(x>=width/2?1:0)];for(let c=0;c<3;c++)raw[(y*width+x)*3+c]=color[c];}
 const png=await sharp(raw,{raw:{width,height,channels:3}}).png().toBuffer();fs.writeFileSync(path.join(dir,'crop-input.png'),png);
 const cropCases=[{x:0,y:0,size:96,color:colors[0]},{x:.5,y:.5,size:192,color:colors[3]}].map((v,i)=>({id:'crop-'+i,capability:'image.crop.v1',schema:'image.raster',outputContract:'image.raster',input:png,parameters:{box:{x:v.x,y:v.y,width:.5,height:.5},paddingRatio:0,targetSize:v.size,jpegQuality:90},verify:async output=>{
  const image=sharp(output),meta=await image.metadata();assert.equal(meta.format,'jpeg');assert.equal(meta.width,v.size);assert.equal(meta.height,v.size);const pixels=await image.removeAlpha().raw().toBuffer();let correct=0;
  for(let p=0;p<pixels.length;p+=3)if(v.color.every((value,c)=>Math.abs(pixels[p+c]-value)<=10))correct++;
  const ratio=correct/(v.size*v.size);assert.ok(ratio>=.98,'CROP_PIXEL_MISMATCH');return {format:meta.format,width:meta.width,height:meta.height,expectedRGB:v.color,matchingPixelRatio:ratio};
 }}));return [...textCases,...vectorCases,...cropCases];
}
async function run(test,device,mode){
 const row={jobId:randomUUID(),case:test.id,capability:test.capability,mode,requestedDevice:device?.name??'AUTO',parameters:test.parameters,inputBytes:test.input.length,inputHash:digest(test.input),state:'RUNNING'};report.samples.push(row);save();const start=performance.now();
 try{const input=await sdk.registerInput(test.input,test.schema),targetId=device?.capabilities.find(c=>c.capability===test.capability&&c.available)?.targetId;if(device&&!targetId)throw Error('DEVICE_CAPABILITY_UNAVAILABLE');
  const task=await sdk.submit({version:3,id:row.jobId,outputContract:test.outputContract,qualityTarget:'reference',nodes:[{id:'compute',capability:test.capability,input,parameters:JSON.stringify(test.parameters),dependsOn:[],...(targetId?{targetId}:{})}]},{requestId:row.jobId,budgetMs:30000,resultDestination:'ORIGIN'});
  const result=await task.result(45000),output=Buffer.from(result.output);row.outputReadyMs=performance.now()-start;row.outputReadyState=result.status.state;
  let status=result.status;const finalDeadline=Date.now()+10000;
  while(status.state!=='SUCCEEDED'&&Date.now()<finalDeadline){if(['FAILED','REJECTED','CANCELLED','CANCELLED_SETTLED'].includes(status.state))break;await new Promise(r=>setTimeout(r,200));status=await task.status();}
  row.elapsedMs=performance.now()-start;
  Object.assign(row,{deviceId:status.deviceId,targetId:status.targetId,traceId:status.traceId,outputBytes:output.length,outputHash:digest(output),finalState:status.state});
  if(test.capability==='image.crop.v1')fs.writeFileSync(path.join(dir,row.jobId+'.jpg'),output);
  assert.equal(status.state,'SUCCEEDED');if(targetId)assert.equal(status.targetId,targetId);
  row.verification=await test.verify(output);row.state='PASS';
  console.log(row.case+' | '+row.requestedDevice+' | PASS | '+row.elapsedMs.toFixed(1)+' ms');
 }catch(e){row.state='FAILED';row.error=e.message;row.elapsedMs=performance.now()-start;console.log(row.case+' | '+row.requestedDevice+' | FAILED | '+e.message);}finally{save();}
}
(async()=>{
 const s=JSON.parse(await request(''));if(s.coordinator.domain!=='REAL')throw Error('REAL_DOMAIN_REQUIRED');
 const devices=s.devices.filter(d=>d.online);assert.equal(devices.length,3,'THREE_ONLINE_DEVICES_REQUIRED');report.devices=devices.map(d=>({id:d.id,name:d.name}));const tests=await cases();
 for(const device of devices)for(const test of tests)await run(test,device,'PINNED');
 for(const test of [tests[0],tests[2],tests[4]])await run(test,null,'AUTO');
 const batchStarted=performance.now();await Promise.all(devices.map((d,i)=>run(tests[i*2],d,'CONCURRENT')));report.concurrentBatchMs=performance.now()-batchStarted;
 const telemetry=JSON.parse(await request('/telemetry'));report.jobs=telemetry.jobs.filter(j=>report.samples.some(s=>s.jobId===j.id)).map(j=>({id:j.id,deviceId:j.deviceId,state:j.state,reason:j.reason,resourcesSettled:j.resourcesSettled,transfers:j.transfers,resultDelivery:j.resultDelivery}));
 report.status=report.samples.every(s=>s.state==='PASS')?'PASS':'FAILED';report.finishedAt=new Date().toISOString();save();console.log('TOTAL '+report.samples.filter(s=>s.state==='PASS').length+'/'+report.samples.length+' '+report.status);if(report.status!=='PASS')process.exitCode=1;
})().catch(e=>{report.status='FAILED';report.error=e.message;save();console.error(e.message);process.exitCode=1;});
