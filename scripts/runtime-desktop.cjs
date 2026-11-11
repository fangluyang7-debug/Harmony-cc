// Local control surface. No LAN listener and no unauthenticated process controls.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const https=require('node:https');
const {randomBytes}=require('node:crypto'),{spawn,execFileSync}=require('node:child_process');
const {lanEnvironment}=require('./start-coordinator-lan.cjs');
const {discoverCenters:discover}=require('../apps/windows-agent/discovery.cjs');
const root=path.resolve(__dirname,'..');
const consoleAssets=new Set(['/index.html','/style.css','/app.js','/dispatch.html','/dispatch.css',
  '/dispatch.js','/dispatch-view.mjs','/dispatch-layout.js','/dispatch-charts.mjs','/scheduler-sdk.js',
  '/qrcode.js','/join-key.mjs','/photo.html','/photo.css','/photo.js','/photo-workflow.mjs','/photo-gallery.mjs','/photo-app-port.mjs']);
function pairingAddress(value){
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('请填写 HTTPS 协调中心地址');
  return url.origin;
}
async function pairingRequest(address,route,body,certificate){
  return new Promise((resolve,reject)=>{
    const payload=body===undefined?undefined:JSON.stringify(body);
    const req=https.request(address+route,{method:payload?'POST':'GET',...(certificate?{ca:certificate}:{rejectUnauthorized:false}),headers:payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',part=>{text+=part;if(text.length>32768)req.destroy(Error('响应过大'));});
      res.on('end',()=>res.statusCode===200||res.statusCode===201?resolve(text):reject(Error('配对码无效、已使用或尝试过于频繁，请重新生成或稍后重试')));
    });req.setTimeout(5000,()=>req.destroy(Error('协调中心连接超时')));req.on('error',reject);req.end(payload);
  });
}
async function pairingCertificate(value){
  const address=pairingAddress(value),certificate=await pairingRequest(address,'/v2/pairing/certificate');
  const fingerprint=new (require('node:crypto').X509Certificate)(certificate).fingerprint256.replaceAll(':','').toLowerCase();
  return {address,certificate,fingerprint};
}
/** Certificate fingerprint the pairing input points at, known before any code is redeemed. */
function pairingTarget(input){
  const value=String(input.invitation||'').trim();
  const link=/&pin=([a-f0-9]{64})$/.exec(value);if(link)return link[1];
  return /^\d{6}$/.test(value)&&/^[a-f0-9]{64}$/.test(String(input.fingerprint||''))?input.fingerprint:null;
}
/** A device installation directory (paired, or an unfinished pairing). Other directories are never touched. */
function deviceInstallation(directory){
  try{const {connection}=JSON.parse(fs.readFileSync(path.join(directory,'agent.json'),'utf8'));return {fingerprint:connection?.fingerprint??''};}
  catch(e){if(e.code!=='ENOENT')return null;}
  return fs.existsSync(path.join(directory,'pairing.pending'))?{fingerprint:''}:null;
}
async function resolvePairingInput(input){
  const value=String(input.invitation||'').trim();
  if(value.startsWith('{'))return JSON.parse(value);
  const link=/^(https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?)\/#device=([a-f0-9-]{36})\.([A-Za-z0-9_-]{24})&pin=([a-f0-9]{64})$/.exec(value);
  const numeric=/^\d{6}$/.test(value);
  if(!link&&!numeric)throw Error('请输入 6 位配对码或完整邀请链接');
  const trust=await pairingCertificate(link?link[1]:input.address);
  if(input.address&&pairingAddress(input.address)!==trust.address)throw Error('邀请与所选中心不一致');
  if(trust.fingerprint!==(link?link[4]:input.fingerprint))throw Error('中心证书已变化，请重新核对指纹');
  const result=JSON.parse(await pairingRequest(trust.address,numeric?'/v2/pairing/code':'/v2/pairing/bootstrap',numeric?{code:value}:{inviteId:link[2],code:link[3]},trust.certificate));
  if(result.invitation?.address!==trust.address||result.invitation?.fingerprint!==trust.fingerprint)throw Error('中心身份不一致');
  return result;
}
function consoleApi(target,ca,route,body,cookie){
  return new Promise((resolve,reject)=>{
    const payload=body===undefined?null:JSON.stringify(body);
    const headers=cookie?{cookie}:{};
    if(payload)Object.assign(headers,{origin:target.origin,'content-type':'application/json','content-length':Buffer.byteLength(payload)});
    const request=https.request(target,{path:'/v2/spaces'+route,method:payload?'POST':'GET',headers,ca},reply=>{
      let text='';
      reply.setEncoding('utf8').on('data',chunk=>{text+=chunk;});
      reply.on('error',reject);
      reply.on('end',()=>{
        try{resolve({status:reply.statusCode,data:JSON.parse(text),cookie:reply.headers['set-cookie']?.[0]?.split(';')[0]});}
        catch(error){reject(error);}
      });
    });
    request.setTimeout(10000,()=>request.destroy(Error('LOCAL_CONSOLE_TIMEOUT')));
    request.on('error',reject);
    request.end(payload??undefined);
  });
}
async function openLocalSpace(directory,target,ca){
  const file=path.join(directory,'local-console-account.json');
  let identity;
  try{identity=JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){
    if(error.code!=='ENOENT')throw error;
    identity={account:'local-'+randomBytes(12).toString('hex'),password:randomBytes(32).toString('hex')};
    fs.writeFileSync(file,JSON.stringify(identity),{flag:'wx',mode:0o600});
  }
  let session=await consoleApi(target,ca,'/login',identity);
  if(session.data.error==='LOGIN_INVALID')session=await consoleApi(target,ca,'/register',{...identity,name:'本机协调者'});
  if(session.status!==200||!session.cookie)throw Error('LOCAL_CONSOLE_SESSION_FAILED');
  const account=await consoleApi(target,ca,'/me',undefined,session.cookie);
  if(account.status!==200)throw Error('LOCAL_CONSOLE_SESSION_FAILED');
  if(account.data.spaces.length===0){
    const space=await consoleApi(target,ca,'/',{name:'本地调度空间'},session.cookie);
    if(space.status!==200)throw Error('LOCAL_CONSOLE_SPACE_FAILED');
  }
  return session.cookie;
}
async function consoleRequest(req,res,control,origin,sessionCookie,spaceRoute){
  if(['same-site','cross-site'].includes(req.headers['sec-fetch-site'])||(req.headers.origin&&req.headers.origin!==origin)||
     (req.method!=='GET'&&req.headers.origin!==origin)){res.writeHead(403).end();return;}
  if(!req.headers.cookie?.split(/;\s*/).includes(sessionCookie)){res.writeHead(403).end();return;}
  res.setHeader('X-Harmony-Local-Console','1');
  if(control.state!=='RUNNING'||control.mode!=='center'){
    res.writeHead(503,{'Content-Type':'text/plain; charset=utf-8'}).end('请返回启动页，先启动协调中心。');return;
  }
  const fail=()=>{
    if(res.headersSent){res.destroy();return;}
    res.writeHead(502,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify({error:'协调中心本机连接失败，请查看运行日志'}));
  };
  try{
    const target=new URL(control.url);
    const directory=control.coordinatorDirectory??path.join(control.dataRoot,'desktop-'+target.hostname);
    const ca=fs.readFileSync(path.join(directory,'coordinator-public.crt'));
    const headers={};
    for(const name of ['content-type','content-length','last-event-id']){
      if(req.headers[name]!==undefined)headers[name]=req.headers[name];
    }
    if(spaceRoute){
      if(!control.localSpace||control.localSpace.expiresAt<=Date.now()){
        const pending={expiresAt:Date.now()+86400000,cookie:openLocalSpace(directory,target,ca)};
        control.localSpace=pending;
        pending.cookie.catch(()=>{if(control.localSpace===pending)control.localSpace=null;});
      }
      headers.cookie=await control.localSpace.cookie;
    }
    if(req.headers.origin)headers.origin=target.origin;
    const upstream=https.request(target,{path:req.url,method:req.method,headers,ca},reply=>{
      if(reply.headers['content-type']!==undefined)res.setHeader('Content-Type',reply.headers['content-type']);
      res.writeHead(reply.statusCode);
      reply.on('error',fail);
      reply.pipe(res);
    });
    upstream.on('error',fail);
    res.on('close',()=>upstream.destroy());
    req.pipe(upstream);
  }catch{fail();}
}
function addresses(){return Object.entries(os.networkInterfaces()).flatMap(([name,list])=>(list||[]).filter(i=>i.family==='IPv4'&&!i.internal).map(i=>({name,address:i.address})));}
function deviceDirectory(directory){return path.resolve(directory||path.join(os.homedir(),'HarmonyRuntime','device'));}
async function openDesktop(){
  const candidates=[path.resolve(root,'../02-Device-Agent-Windows-x64/Harmony.exe'),path.join(process.env.LOCALAPPDATA||os.homedir(),'Programs/Harmony/Harmony.exe'),path.join(root,'.test/windows-app/Harmony/Harmony.exe')];
  const executable=candidates.find(p=>fs.existsSync(p));if(!executable)throw Error('请先构建或安装 Harmony 协作空间应用');
  const child=spawn(executable,[],{windowsHide:true,detached:true,stdio:'ignore'});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  child.unref();return {opened:true};
}
function openssl(){if(process.env.COORDINATOR_OPENSSL)return process.env.COORDINATOR_OPENSSL;
  const dirs=(process.env.PATH||'').split(path.delimiter);
  if(process.platform==='win32')try{for(const git of execFileSync('where.exe',['git'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/))dirs.push(path.dirname(git));}catch{}
  for(const dir of dirs)for(const candidate of [path.join(dir,'openssl.exe'),path.resolve(dir,'../usr/bin/openssl.exe')])if(fs.existsSync(candidate))return candidate;
  return 'openssl';}
class RuntimeControl {
  constructor(options={}){this.dataRoot=options.dataRoot||path.join(root,'services/coordinator/data');this.child=null;this.state='STOPPED';this.logs=[];this.url=null;this.mode=null;this.coordinatorGone=false;this.agentDirectory=null;}
  log(value){this.logs.push(value);this.logs=this.logs.slice(-100);}
  launch(script,args,env){
    if(this.child)throw Error('请先停止当前服务');
    this.state='STARTING';this.logs=[];this.coordinatorGone=false;let gone=false;
    const child=spawn(process.execPath,[script,...args],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});this.child=child;
    let pending='';const collect=chunk=>{pending+=chunk.toString();const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines){this.log(line);if(line.startsWith('COORDINATOR_GONE'))gone=true;if(line.startsWith('Coordinator ready:')||line.startsWith('CPU host started:'))this.state='RUNNING';}};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    child.on('error',e=>{this.log(e.code||'PROCESS_START_FAILED');this.child=null;this.state='FAILED';});
    child.on('exit',code=>{if(pending)this.log(pending);this.child=null;
      if(gone&&this.mode==='agent'&&this.agentDirectory){this.retirePairing(this.agentDirectory);this.state='STOPPED';return;}
      this.state=code===0?'STOPPED':'FAILED';});
  }
  startCenter(input){
    if(this.child)throw Error('服务已在运行');
    const address=input.address,port=String(input.port||7443);
    // Keep each network identity in its own directory, never replace an existing certificate.
    const env=lanEnvironment(address,port,process.env.HARMONY_COORDINATOR_DATA_DIR||path.join(this.dataRoot,'desktop-'+address),{...process.env,COORDINATOR_OPENSSL:openssl()});
    const bundledSchemaEngine=path.join(root,'node_modules/@prisma/engines/schema-engine-windows.exe');
    if(process.platform==='win32'&&!env.PRISMA_SCHEMA_ENGINE_BINARY&&fs.existsSync(bundledSchemaEngine))env.PRISMA_SCHEMA_ENGINE_BINARY=bundledSchemaEngine;
    if(input.suite){if(!path.isAbsolute(input.suite)||!fs.existsSync(input.suite))throw Error('协调中心的评测套件路径不存在');env.COORDINATOR_IMAGE_ENCODING_SUITE=input.suite;}
    if(!fs.existsSync(path.join(root,'services/coordinator/dist/main.js')))throw Error('请先完成协调者构建');
    this.mode='center';this.url=env.COORDINATOR_PUBLIC_URL;
    this.coordinatorDirectory=env.COORDINATOR_DATA_DIR;
    this.localSpace=null;
    this.launch(path.join(root,'scripts/start-coordinator-lan.cjs'),[address,port,env.COORDINATOR_DATA_DIR],env);
  }
  startAgent(input){
    if(this.child)throw Error('服务已在运行');
    const directory=deviceDirectory(input.directory);
    if(!fs.existsSync(path.join(directory,'agent.json'))||!fs.existsSync(path.join(directory,'contribution.json')))throw Error('请先导入邀请并完成配对');
    const env={...process.env};
    if(input.backend){if(!['CPU','CUDA'].includes(input.backend))throw Error('图像后端无效');env.PC_IMAGE_BACKEND=input.backend;}
    if(input.python){if(!path.isAbsolute(input.python)||!fs.existsSync(input.python))throw Error('Python 路径不存在');env.PC_IMAGE_PYTHON=input.python;}
    if(input.suite){if(!path.isAbsolute(input.suite)||!fs.existsSync(input.suite))throw Error('评测套件路径不存在');env.PC_IMAGE_ENCODING_SUITE=input.suite;}
    if(input.backend&&!env.PC_IMAGE_ENCODING_SUITE)throw Error('请先配置可信编码套件');
    this.mode='agent';this.url=null;this.agentDirectory=directory;
    this.launch(path.join(root,'services/pc-agent/dist/host-main.js'),[path.join(directory,'agent.json'),path.join(directory,'contribution.json')],env);
  }
  async pair(input){
    if(this.child)throw Error('请先停止当前服务');
    if(typeof input.invitation!=='string')throw Error('请导入完整设备邀请');
    const directory=deviceDirectory(input.directory);
    // Decide before redeeming the one-time code. An old pairing to another coordinator, or an
    // unfinished pairing, is moved aside (ledger kept); the same coordinator just needs starting.
    let retire=false;
    if(fs.existsSync(directory)){
      const target=pairingTarget(input),existing=deviceInstallation(directory);
      if(!existing||!target)throw Error('安装目录已存在，请恢复该设备或选择新目录；不覆盖账本');
      if(existing.fingerprint===target)throw Error('本机已与该协调中心配对，请直接打开设备调度件电源');
      retire=true;
    }
    const bootstrap=await resolvePairingInput(input);
    if(!bootstrap?.invitation||!bootstrap.contribution||!bootstrap.holderInstanceId)throw Error('请导入完整设备邀请');
    if(retire&&fs.existsSync(directory))fs.renameSync(directory,directory+'.retired-'+new Date().toISOString().replace(/[:.]/g,'-'));
    fs.mkdirSync(path.dirname(directory),{recursive:true});
    const staging=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-pair-')),file=path.join(staging,'invitation.json');
    fs.writeFileSync(file,JSON.stringify(bootstrap),{mode:0o600});
    try{
      await new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,[path.join(root,'services/pc-agent/dist/pairing-main.js'),file,directory],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
        child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('配对失败；保留安装目录用于对账，勿重复兑换')));
      });
      fs.writeFileSync(path.join(directory,'contribution.json'),JSON.stringify(bootstrap.contribution),{flag:'wx',mode:0o600});
      return {directory};
    }finally{fs.unlinkSync(file);fs.rmdirSync(staging);}
  }
  /** The coordinator stopped: move the pairing aside (ledger kept for audit) so the device can pair again. */
  retirePairing(directory){
    try{const target=directory+'.retired-'+new Date().toISOString().replace(/[:.]/g,'-');fs.renameSync(directory,target);
      this.coordinatorGone=true;this.log('协调中心已关闭或不可达，本机已断开并清除配对（原记录移至 '+path.basename(target)+'）。请重新配对。');}
    catch(e){this.log('协调中心已断开，但配对记录无法移除：'+(e.code||e.message));}
  }
  deviceStatus(input){
    const directory=deviceDirectory(input.directory);
    try{
      const {connection}=JSON.parse(fs.readFileSync(path.join(directory,'agent.json'),'utf8'));
      const policy=JSON.parse(fs.readFileSync(path.join(directory,'contribution.json'),'utf8'));
      return {paired:true,address:connection.address,cpu:policy.maxCpuThreads,memory:policy.maxMemoryBytes};
    }catch(e){if(e.code==='ENOENT')return {paired:false};throw Error('设备配对记录无法读取，请检查安装目录');}
  }
  stop(){if(this.child){this.state='STOPPING';if(this.child.connected)this.child.send({type:'shutdown'},error=>{if(error)this.log('停止请求未确认，请查看进程状态');});}}
  snapshot(){return {state:this.state,mode:this.mode,url:this.url,logs:this.logs,addresses:addresses(),coordinatorGone:this.coordinatorGone};}
}
async function main(options={openBrowser:true}){
  process.chdir(root);const control=new RuntimeControl(),token=randomBytes(32).toString('hex');let origin='';let mutating=false;
  const role=options.role??'both';
  const localToken=randomBytes(32).toString('hex');
  let sessionCookie;
  if(!['both','center','agent'].includes(role))throw Error('DESKTOP_ROLE_INVALID');
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    if(req.headers.host!==new URL(origin).host){res.writeHead(403).end();return;}
    const asset=req.method==='GET'&&({
      '/':role==='agent'?'agent.html':'index.html',
      '/device':role==='center'?null:'agent.html',
      '/desktop.js':'desktop.js'
    })[req.url];
    if(asset){
      res.setHeader('Content-Type',asset.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8');
      res.end(fs.readFileSync(path.join(root,'apps/runtime-desktop',asset)));return;
    }
    const pathname=req.url.split('?')[0];
    const webAsset=req.method==='GET'&&(consoleAssets.has(pathname)||/^\/fonts\/[\w.-]+\.woff2?$/.test(pathname));
    const spaceRoute=['GET','POST','PUT'].includes(req.method)&&/^\/v2\/spaces(?:\/|$)/.test(pathname);
    if(role!=='agent'&&(webAsset||spaceRoute)){
      if(/^\/v2\/spaces\/(login|register|logout)\/?$/.test(pathname)){res.writeHead(404).end();return;}
      await consoleRequest(req,res,control,origin,sessionCookie,spaceRoute);return;
    }
    if(req.headers['x-runtime-token']!==token||req.headers.origin&&req.headers.origin!==origin){res.writeHead(403).end();return;}
    try{
      if(req.method==='GET'&&req.url==='/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...control.snapshot(),role}));return;}
      if(req.method==='GET'&&req.url==='/discover'&&role!=='center'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({centers:await discover()}));return;}
      if(req.method!=='POST'||req.headers.origin!==origin)throw Error('REQUEST_REJECTED');
      if(req.url==='/console/session'&&role!=='agent'&&control.mode==='center'&&control.state==='RUNNING'){
        res.writeHead(200,{'Set-Cookie':sessionCookie+'; Path=/; HttpOnly; SameSite=Strict','Content-Type':'application/json'}).end('{}');return;
      }
      let body='';for await(const chunk of req){body+=chunk;if(body.length>32768)throw Error('REQUEST_LIMIT');}
      if(mutating)throw Error('操作进行中');mutating=true;
      try{const input=JSON.parse(body||'{}');let result={};
        if(req.url==='/center/start'&&role!=='agent')control.startCenter(input);
        else if(req.url==='/agent/start'&&role!=='center')control.startAgent(input);
        else if(req.url==='/agent/certificate'&&role!=='center')result=await pairingCertificate(input.address);
        else if(req.url==='/agent/pair'&&role!=='center')result=await control.pair(input);
        else if(req.url==='/agent/status'&&role!=='center')result=control.deviceStatus(input);
        else if(req.url==='/desktop/open')result=await openDesktop();
        else if(req.url==='/stop')control.stop();else throw Error('NOT_FOUND');
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
      }finally{mutating=false;}
    }catch(e){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:e.message}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  sessionCookie='harmony_local_'+server.address().port+'='+localToken;
  const url=origin+'/#'+token;
  if(options.openBrowser){if(process.platform==='win32')spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore'}).on('error',()=>console.log('请在本机浏览器打开：'+url));else console.log('请在本机浏览器打开：'+url);}
  process.on('SIGINT',()=>{control.stop();if(!control.child)server.close();else control.child.once('exit',()=>server.close());});
  return {server,control,url};
}
module.exports={RuntimeControl,addresses,main,pairingCertificate,resolvePairingInput};
if(require.main===module)main({openBrowser:true,role:process.argv[2]}).catch(e=>{console.error(e.message);process.exitCode=1;});
