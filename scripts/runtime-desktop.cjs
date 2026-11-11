// Local control surface. No LAN listener and no unauthenticated process controls.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const https=require('node:https');
const {randomBytes}=require('node:crypto'),{spawn,execFileSync}=require('node:child_process');
const {lanEnvironment}=require('./start-coordinator-lan.cjs');
const {discoverCenters:discover}=require('../apps/windows-agent/discovery.cjs');
const {DeviceBinding}=require('./runtime-device-binding.cjs');
const root=path.resolve(__dirname,'..');
const consoleAssets=new Set(['/index.html','/style.css','/app.js','/dispatch.html','/dispatch.css',
  '/dispatch.js','/dispatch-view.mjs','/dispatch-layout.js','/dispatch-charts.mjs','/scheduler-sdk.js',
  '/qrcode.js','/join-key.mjs','/photo.html','/photo.css','/photo.js','/photo-workflow.mjs','/photo-gallery.mjs','/photo-app-port.mjs']);
function pairingAddress(value){
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('请填写 HTTPS 协调中心地址');
  return url.origin;
}
// Same budget as the HarmonyOS pairing page (connect + read), with an absolute deadline so a stalled
// TLS handshake cannot hang the dialog. Every pairing request opens a fresh socket: a kept-alive socket
// that the coordinator closed after its 5 s idle timeout would otherwise surface as a random reset.
const PAIRING_TIMEOUT_MS=Number(process.env.HARMONY_PAIRING_TIMEOUT_MS)||10000;
const certificateFingerprint=pem=>new (require('node:crypto').X509Certificate)(pem).fingerprint256.replaceAll(':','').toLowerCase();
function pairingFailure(address,route,error){
  const code=error.code||error.message,where=' · '+route;
  if(code==='PAIRING_TIMEOUT')return '协调中心 '+address+' 在 '+Math.round(PAIRING_TIMEOUT_MS/1000)+' 秒内没有响应'+where+'。请确认中心已启动、本机与中心在同一网络，并放行中心电脑的 TCP 7443 端口。';
  if(code==='ECONNREFUSED')return '协调中心 '+address+' 拒绝连接'+where+'：中心未启动或端口不对。';
  if(['EHOSTUNREACH','ENETUNREACH','ETIMEDOUT','ENOTFOUND','EADDRNOTAVAIL'].includes(code))return '无法到达协调中心 '+address+'（'+code+'）'+where+'：本机与中心不在同一网络，或被防火墙拦截。';
  if(code==='ECONNRESET'||/socket hang up/.test(code))return '与协调中心的连接被中断'+where+'，请重试一次。';
  if(/CERT|certificate|self.signed|altname|unable to verify/i.test(code))return '协调中心证书校验失败'+where+'（'+code+'）：中心证书已变化，请重新核对指纹。';
  return '连接协调中心失败'+where+'：'+code;
}
function pairingRejection(route,status,text){
  let code='';try{const data=JSON.parse(text);code=typeof data.message==='string'?data.message:typeof data.error==='string'?data.error:'';}catch{}
  if(code==='PAIRING_RATE_LIMITED')return '配对尝试过于频繁，请 5 分钟后再试。';
  if(status===503)return '协调中心尚未就绪（正在恢复或未配置对外地址），请稍后再试。';
  if(route==='/v2/pairing/certificate')return '无法读取协调中心证书（HTTP '+status+'）。';
  return '配对码无效、已使用或已过期（HTTP '+status+(code?' '+code:'')+'）。每个配对码只能兑换一次，请在协调中心重新生成后再试。';
}
async function pairingRequest(address,route,body,certificate,retry=true){
  const payload=body===undefined?undefined:JSON.stringify(body);
  try{
    return await new Promise((resolve,reject)=>{
      const req=https.request(address+route,{method:payload?'POST':'GET',agent:false,...(certificate?{ca:certificate}:{rejectUnauthorized:false}),headers:payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}},res=>{
        let text='';res.setEncoding('utf8');res.on('data',part=>{text+=part;if(text.length>32768)req.destroy(Error('响应过大'));});
        res.on('end',()=>res.statusCode===200||res.statusCode===201?resolve(text):reject(Object.assign(Error(pairingRejection(route,res.statusCode,text)),{rejected:true})));
      });
      const deadline=setTimeout(()=>req.destroy(Object.assign(Error('PAIRING_TIMEOUT'),{code:'PAIRING_TIMEOUT'})),PAIRING_TIMEOUT_MS);
      req.once('close',()=>clearTimeout(deadline));
      req.setTimeout(PAIRING_TIMEOUT_MS,()=>req.destroy(Object.assign(Error('PAIRING_TIMEOUT'),{code:'PAIRING_TIMEOUT'})));
      req.on('error',reject);req.end(payload);
    });
  }catch(error){
    if(error.rejected)throw error;
    // A reset during an idempotent read is retried once; a redemption is never repeated (the code is single-use).
    if(retry&&!payload&&(error.code==='ECONNRESET'||/socket hang up/.test(error.message)))return pairingRequest(address,route,body,certificate,false);
    throw Error(pairingFailure(address,route,error));
  }
}
async function pairingCertificate(value){
  const address=pairingAddress(value),certificate=await pairingRequest(address,'/v2/pairing/certificate');
  return {address,certificate,fingerprint:certificateFingerprint(certificate)};
}
/** Authenticated device request to the paired coordinator, pinned to the certificate recorded at pairing. */
function deviceRequest(connection,route,body){
  return new Promise((resolve,reject)=>{
    const payload=JSON.stringify(body??{}),address=connection.address.replace(/\/$/,'');
    const req=https.request(address+route,{method:'POST',agent:false,ca:connection.certificate,rejectUnauthorized:true,
      checkServerIdentity:(_host,cert)=>cert.fingerprint256.replaceAll(':','').toLowerCase()===connection.fingerprint?undefined:Error('PIN_MISMATCH'),
      headers:{Authorization:'Bearer '+connection.credential,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',part=>{text+=part;if(text.length>32768)req.destroy(Error('响应过大'));});
      res.on('end',()=>{let data={};try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,data});});
    });
    const deadline=setTimeout(()=>req.destroy(Object.assign(Error('PAIRING_TIMEOUT'),{code:'PAIRING_TIMEOUT'})),PAIRING_TIMEOUT_MS);
    req.once('close',()=>clearTimeout(deadline));
    req.setTimeout(PAIRING_TIMEOUT_MS,()=>req.destroy(Object.assign(Error('PAIRING_TIMEOUT'),{code:'PAIRING_TIMEOUT'})));
    req.on('error',error=>reject(Error(pairingFailure(address,route,error))));req.end(payload);
  });
}
/** Whether the coordinator of an existing pairing still answers (any HTTP reply counts). */
async function coordinatorReachable(directory){
  let connection;try{({connection}=JSON.parse(fs.readFileSync(path.join(directory,'agent.json'),'utf8')));}catch{return false;}
  return new Promise(resolve=>{const req=https.get(connection.address.replace(/\/$/,'')+'/v2/identity',{ca:connection.certificate},res=>{res.resume();resolve(true);});
    req.setTimeout(5000,()=>req.destroy(Error('TIMEOUT')));req.on('error',()=>resolve(false));});
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
async function resolvePairingInput(input,log=()=>{}){
  const value=String(input.invitation||'').trim();
  if(value.startsWith('{'))return JSON.parse(value);
  const link=/^(https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?)\/#device=([a-f0-9-]{36})\.([A-Za-z0-9_-]{24})&pin=([a-f0-9]{64})$/.exec(value);
  const numeric=/^\d{6}$/.test(value);
  if(!link&&!numeric)throw Error('请输入 6 位配对码或完整邀请链接');
  // Like the phone, reuse the certificate the user just confirmed instead of fetching it a second time.
  let trust=null;
  if(numeric&&typeof input.certificate==='string'&&input.address){
    try{const fingerprint=certificateFingerprint(input.certificate);if(fingerprint===input.fingerprint)trust={address:pairingAddress(input.address),certificate:input.certificate,fingerprint};}catch{}
  }
  if(!trust){log('配对：读取协调中心证书…');trust=await pairingCertificate(link?link[1]:input.address);}
  if(input.address&&pairingAddress(input.address)!==trust.address)throw Error('邀请与所选中心不一致');
  if(trust.fingerprint!==(link?link[4]:input.fingerprint))throw Error('中心证书已变化，请重新核对指纹');
  log('配对：向 '+trust.address+' 兑换'+(numeric?'配对码':'邀请链接')+'…');
  const result=JSON.parse(await pairingRequest(trust.address,numeric?'/v2/pairing/code':'/v2/pairing/bootstrap',numeric?{code:value}:{inviteId:link[2],code:link[3]},trust.certificate));
  if(result.invitation?.address!==trust.address||result.invitation?.fingerprint!==trust.fingerprint)throw Error('中心身份不一致');
  return result;
}
const pairingChildFailure={PAIR_TIMEOUT:'向协调中心登记设备超时（/v2/pair）。配对码已被消耗，请在协调中心重新生成配对码后重试。',PAIR_REJECTED:'协调中心拒绝登记设备（邀请已使用或已过期），请重新生成配对码。',PAIR_DOMAIN_INVALID:'协调中心与邀请的运行域不一致。',INVITATION_INVALID:'邀请内容无效或已过期。',INVITATION_TRUST_INVALID:'邀请中的证书与地址不匹配。'};
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
  const candidates=[path.resolve(root,'../02-Device-Agent-Windows-x64/ZhiDiaoHongShu.exe'),path.join(process.env.LOCALAPPDATA||os.homedir(),'Programs/ZhiDiao/02-Device-Agent-Windows-x64/ZhiDiaoHongShu.exe')];
  const executable=candidates.find(p=>fs.existsSync(p));if(!executable)throw Error('请先安装新版智调鸿枢设备调度件');
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
  constructor(options={}){this.dataRoot=options.dataRoot||path.join(root,'services/coordinator/data');this.binding=options.bindingFile?new DeviceBinding(options.bindingFile):null;this.child=null;this.state='STOPPED';this.logs=[];this.url=null;this.mode=null;this.coordinatorGone=false;this.agentDirectory=null;this.connected=false;}
  log(value){this.logs.push(value);this.logs=this.logs.slice(-100);}
  launch(script,args,env){
    if(this.child)throw Error('请先停止当前服务');
    this.state='STARTING';this.logs=[];this.coordinatorGone=false;this.connected=false;let gone=false;
    const child=spawn(process.execPath,[script,...args],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});this.child=child;
    let pending='';const collect=chunk=>{pending+=chunk.toString();const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines){this.log(line);if(line.startsWith('COORDINATOR_GONE'))gone=true;if(line.startsWith('Coordinator ready:')||line.startsWith('CPU host started:'))this.state='RUNNING';
      // The host reports its control channel so the page can show "connected" rather than just "process running".
      if(line.startsWith('CONTROL_ONLINE'))this.connected=true;else if(line.startsWith('CONTROL_OFFLINE')||line.startsWith('COORDINATOR_GONE'))this.connected=false;}};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    child.on('error',e=>{this.log(e.code||'PROCESS_START_FAILED');this.child=null;this.state='FAILED';this.connected=false;});
    child.on('exit',code=>{if(pending)this.log(pending);this.child=null;this.connected=false;
      if(gone&&this.mode==='agent'&&this.agentDirectory){this.retirePairing(this.agentDirectory);this.state='STOPPED';return;}
      this.state=code===0?'STOPPED':'FAILED';});
  }
  startCenter(input){
    if(this.child)throw Error('服务已在运行');
    const address=input.address,port=String(input.port||7443);
    // Each desktop start creates a new center, including a fresh identity and empty database.
    const sessions=path.join(process.env.HARMONY_COORDINATOR_DATA_DIR||this.dataRoot,'sessions');
    const env=lanEnvironment(address,port,sessions,{...process.env,COORDINATOR_OPENSSL:openssl()});
    const bundledSchemaEngine=path.join(root,'node_modules/@prisma/engines/schema-engine-windows.exe');
    if(process.platform==='win32'&&!env.PRISMA_SCHEMA_ENGINE_BINARY&&fs.existsSync(bundledSchemaEngine))env.PRISMA_SCHEMA_ENGINE_BINARY=bundledSchemaEngine;
    if(input.suite){if(!path.isAbsolute(input.suite)||!fs.existsSync(input.suite))throw Error('协调中心的评测套件路径不存在');env.COORDINATOR_IMAGE_ENCODING_SUITE=input.suite;}
    if(!fs.existsSync(path.join(root,'services/coordinator/dist/main.js')))throw Error('请先完成协调者构建');
    fs.mkdirSync(sessions,{recursive:true});
    env.COORDINATOR_DATA_DIR=fs.mkdtempSync(path.join(sessions,'desktop-'+address+'-'));
    this.mode='center';this.url=env.COORDINATOR_PUBLIC_URL;
    this.coordinatorDirectory=env.COORDINATOR_DATA_DIR;
    this.localSpace=null;
    this.launch(path.join(root,'scripts/start-coordinator-lan.cjs'),[address,port,env.COORDINATOR_DATA_DIR],env);
  }
  startAgent(input){
    if(this.child)throw Error('服务已在运行');
    const directory=deviceDirectory(input.directory||this.binding?.data.active?.directory);
    this.binding?.assertActive(directory);
    if(!fs.existsSync(path.join(directory,'agent.json'))||!fs.existsSync(path.join(directory,'contribution.json')))throw Error('请先导入邀请并完成配对');
    const env={...process.env};
    if(input.backend){if(!['CPU','CUDA'].includes(input.backend))throw Error('图像后端无效');env.PC_IMAGE_BACKEND=input.backend;}
    if(input.python){if(!path.isAbsolute(input.python)||!fs.existsSync(input.python))throw Error('Python 路径不存在');env.PC_IMAGE_PYTHON=input.python;}
    if(input.suite){if(!path.isAbsolute(input.suite)||!fs.existsSync(input.suite))throw Error('评测套件路径不存在');env.PC_IMAGE_ENCODING_SUITE=input.suite;}
    if(input.backend&&!env.PC_IMAGE_ENCODING_SUITE)throw Error('请先配置可信编码套件');
    if(this.binding&&!this.binding.data.active)this.binding.activate(directory);
    this.mode='agent';this.url=null;this.agentDirectory=directory;
    this.launch(path.join(root,'services/pc-agent/dist/host-main.js'),[path.join(directory,'agent.json'),path.join(directory,'contribution.json')],env);
  }
  async pair(input){
    if(this.child)throw Error('请先停止当前服务');
    if(typeof input.invitation!=='string')throw Error('请导入完整设备邀请');
    // Decide before redeeming the one-time code: the same coordinator just needs starting; unsettled
    // work blocks a switch unless the old pairing is a different coordinator that no longer answers.
    const target=pairingTarget(input),requested=deviceDirectory(input.directory),activeDirectory=this.binding?.data.active?.directory;
    let retire=false;
    for(const candidate of [requested,activeDirectory].filter(Boolean)){const existing=fs.existsSync(candidate)?deviceInstallation(candidate):null;
      if(existing&&target&&existing.fingerprint===target)throw Error('本机已与该协调中心配对，请直接打开设备调度件电源');}
    if(fs.existsSync(requested)&&!this.binding){if(!deviceInstallation(requested)||!target)throw Error('安装目录已存在，请恢复该设备或选择新目录；不覆盖账本');retire=true;}
    if(this.binding&&activeDirectory){
      try{this.binding.assertSettled();}
      catch(error){if(!target||await coordinatorReachable(activeDirectory))throw error;this.log('旧协调中心不可达，其未结算记录保留在原账本中，继续配对新协调中心。');}
    }
    const bootstrap=await resolvePairingInput(input,line=>this.log(line));
    let directory=requested;
    if(retire&&fs.existsSync(directory))fs.renameSync(directory,directory+'.retired-'+new Date().toISOString().replace(/[:.]/g,'-'));
    if(fs.existsSync(directory)){if(!this.binding)throw Error('安装目录已存在，请恢复该设备或选择新目录；不覆盖账本');directory=path.join(path.dirname(directory),'device-'+bootstrap.holderInstanceId);}
    if(this.binding)bootstrap.localDevice=this.binding.context();
    if(!bootstrap?.invitation||!bootstrap.contribution||!bootstrap.holderInstanceId)throw Error('请导入完整设备邀请');
    fs.mkdirSync(path.dirname(directory),{recursive:true});
    const staging=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-pair-')),file=path.join(staging,'invitation.json');
    fs.writeFileSync(file,JSON.stringify(bootstrap),{mode:0o600});
    try{
      this.log('配对：向协调中心登记本机并建立账本…');
      await new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,[path.join(root,'services/pc-agent/dist/pairing-main.js'),file,directory],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
        let output='';const collect=chunk=>{output=(output+chunk.toString()).slice(-4096);};child.stdout.on('data',collect);child.stderr.on('data',collect);
        child.on('error',reject);child.on('exit',code=>{
          if(code===0){resolve();return;}
          const reason=/PAIRING_FAILED: ([A-Z_]+)/.exec(output)?.[1]??'';this.log('配对失败：'+(output.trim().split(/\r?\n/).pop()||'exit '+code));
          reject(Error((pairingChildFailure[reason]??'配对失败（'+(reason||'exit '+code)+'）；保留安装目录用于对账，勿重复兑换。')));
        });
      });
      fs.writeFileSync(path.join(directory,'contribution.json'),JSON.stringify(bootstrap.contribution),{flag:'wx',mode:0o600});
      this.binding?.activate(directory);this.coordinatorGone=false;this.log('配对完成：'+bootstrap.invitation.address);return {directory};
    }finally{fs.unlinkSync(file);fs.rmdirSync(staging);}
  }
  /**
   * Leave the current space the way the phone does: the coordinator revokes this device's credential
   * (SPACE_SWITCH_BUSY while work is unsettled), then the local pairing is moved aside with its ledger.
   * `force` skips the coordinator only when the caller has accepted that it is unreachable.
   */
  async leave(input={}){
    if(this.child)throw Error('请先停止设备调度件，再退出协作空间');
    const directory=deviceDirectory(input.directory||this.binding?.data.active?.directory);
    this.binding?.assertActive(directory);
    let connection;
    try{({connection}=JSON.parse(fs.readFileSync(path.join(directory,'agent.json'),'utf8')));}
    catch(e){if(e.code==='ENOENT')throw Error('本机没有配对记录');throw Error('设备配对记录无法读取，请检查安装目录');}
    if(!input.force){
      try{this.binding?.assertSettled();}
      catch{throw Error('本机账本还有未结算的任务记录。请先开启设备调度件让其完成结算；若协调中心已关闭，可选择仅在本机清除配对。');}
      this.log('退出：请求协调中心 '+connection.address+' 注销本机…');
      let reply;
      try{reply=await deviceRequest(connection,'/v2/devices/leave',{});}
      catch(e){throw Object.assign(Error('协调中心未确认退出：'+e.message+' 若中心已关闭，可选择仅在本机清除配对。'),{code:'COORDINATOR_UNREACHABLE'});}
      const error=typeof reply.data?.error==='string'?reply.data.error:typeof reply.data?.message==='string'?reply.data.message:'';
      if(reply.status===409||error==='SPACE_SWITCH_BUSY')throw Error('协调中心上还有本机未结算的任务，请等待其完成后再退出。');
      // 401: the credential is already revoked, i.e. the coordinator has dropped this device.
      if(reply.status!==200&&reply.status!==201&&reply.status!==401)throw Error('协调中心拒绝退出（HTTP '+reply.status+(error?' '+error:'')+'）。');
      this.log(reply.status===401?'退出：协调中心已不再认识本机凭据，按已注销处理。':'退出：协调中心已注销本机。');
    }else this.log('退出：未经协调中心确认，仅在本机清除配对。');
    const target=directory+'.left-'+new Date().toISOString().replace(/[:.]/g,'-');
    fs.renameSync(directory,target);
    if(this.binding?.data.active&&path.resolve(this.binding.data.active.directory)===path.resolve(directory)){this.binding.data.active=null;this.binding.save();}
    this.coordinatorGone=false;this.log('已退出协作空间；原配对记录与账本移至 '+path.basename(target)+'。');
    return {left:true,confirmed:!input.force,directory:target};
  }
  /** The coordinator stopped: move the pairing aside (ledger kept for audit) so the device can pair again. */
  retirePairing(directory){
    try{const target=directory+'.retired-'+new Date().toISOString().replace(/[:.]/g,'-');fs.renameSync(directory,target);
      // The device keeps its installation identity and history (P09); only the active pointer is cleared.
      if(this.binding?.data.active&&path.resolve(this.binding.data.active.directory)===path.resolve(directory)){this.binding.data.active=null;this.binding.save();}
      this.coordinatorGone=true;this.log('协调中心已关闭或不可达，本机已断开并清除配对（原记录移至 '+path.basename(target)+'）。请重新配对。');}
    catch(e){this.log('协调中心已断开，但配对记录无法移除：'+(e.code||e.message));}
  }
  deviceStatus(input){
    const directory=deviceDirectory(input.directory||this.binding?.data.active?.directory);
    this.binding?.assertActive(directory);
    try{
      const {connection}=JSON.parse(fs.readFileSync(path.join(directory,'agent.json'),'utf8'));
      const policy=JSON.parse(fs.readFileSync(path.join(directory,'contribution.json'),'utf8'));
      return {paired:true,directory,groupId:JSON.parse(fs.readFileSync(path.join(directory,'agent.json'))).identity.groupId,address:connection.address,cpu:policy.maxCpuThreads,memory:policy.maxMemoryBytes,vram:policy.maxVramBytes??0,capacityMode:policy.capacityMode==='auto'?'auto':'fixed'};
    }catch(e){if(e.code==='ENOENT')return {paired:false};throw Error('设备配对记录无法读取，请检查安装目录');}
  }
  stop(){if(this.child){this.state='STOPPING';if(this.child.connected)this.child.send({type:'shutdown'},error=>{if(error)this.log('停止请求未确认，请查看进程状态');});}}
  snapshot(){return {state:this.state,mode:this.mode,url:this.url,logs:this.logs,addresses:addresses(),coordinatorGone:this.coordinatorGone,connected:this.connected};}
}
async function main(options={openBrowser:true}){
  process.chdir(root);const control=new RuntimeControl({bindingFile:options.bindingFile??path.join(os.homedir(),'HarmonyRuntime','device-binding.json')}),token=randomBytes(32).toString('hex');let origin='';let mutating=false;
  const role=options.role??'both';
  const localToken=randomBytes(32).toString('hex');
  let sessionCookie;
  async function localCall(route,body){
    if(control.state!=='RUNNING'||control.mode!=='center')throw Error('请先启动协调中心');
    const target=new URL(control.url),directory=control.coordinatorDirectory,ca=fs.readFileSync(path.join(directory,'coordinator-public.crt'));
    if(!control.localSpace||control.localSpace.expiresAt<=Date.now())control.localSpace={expiresAt:Date.now()+86400000,cookie:openLocalSpace(directory,target,ca)};
    const response=await consoleApi(target,ca,route,body,await control.localSpace.cookie);if(response.status!==200)throw Error(response.data.error||'WORKSPACE_REQUEST_FAILED');return response.data;
  }
  let workspaceQueue=Promise.resolve();
  function currentWorkspace(name){const next=workspaceQueue.then(()=>readWorkspace(name));workspaceQueue=next.catch(()=>{});return next;}
  async function readWorkspace(name){
    const account=await localCall('/me'),file=path.join(control.coordinatorDirectory,'current-workspace.json');let current;try{current=JSON.parse(fs.readFileSync(file));}catch(e){if(e.code!=='ENOENT')throw e;}
    let space=account.spaces.find(s=>s.id===current?.id);
    if(name!==undefined){if(typeof name!=='string'||!name.trim()||name.length>80)throw Error('SPACE_NAME_REQUIRED');const created=await localCall('/',{name:name.trim()});space={id:created.id,name:name.trim()};}
    else space??=account.spaces[0];
    if(!space)throw Error('SPACE_NOT_FOUND');fs.writeFileSync(file,JSON.stringify(space));return space;
  }
  let display=null;
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
    if(req.method==='GET'&&req.url==='/console/workspace'){
      if(!sessionCookie||!req.headers.cookie?.split(/;\s*/).includes(sessionCookie)||req.headers['sec-fetch-site']==='cross-site'){res.writeHead(403).end();return;}
      try{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await currentWorkspace()));}catch(e){res.writeHead(503).end(JSON.stringify({error:e.message}));}return;
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
      if(req.method==='GET'&&req.url==='/workspace'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await currentWorkspace()));return;}
      if(req.method==='GET'&&req.url==='/discover'&&role!=='center'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({centers:await discover()}));return;}
      if(req.method!=='POST'||req.headers.origin!==origin)throw Error('REQUEST_REJECTED');
      if(req.url==='/console/session'&&role!=='agent'&&control.mode==='center'&&control.state==='RUNNING'){
        res.writeHead(200,{'Set-Cookie':sessionCookie+'; Path=/; HttpOnly; SameSite=Strict','Content-Type':'application/json'}).end('{}');return;
      }
      let body='';for await(const chunk of req){body+=chunk;if(body.length>32768)throw Error('REQUEST_LIMIT');}
      if(mutating)throw Error('操作进行中');mutating=true;
      try{const input=JSON.parse(body||'{}');let result={};
        if(req.url==='/center/start'&&role!=='agent')control.startCenter(input);
        else if(req.url==='/workspace/create'&&role!=='agent')result=await currentWorkspace(input.name);
        else if(req.url==='/display/open'&&role!=='agent'){if(!display)throw Error('DISPLAY_UNAVAILABLE');result={url:display.url};}
        else if(req.url==='/agent/start'&&role!=='center')control.startAgent(input);
        else if(req.url==='/agent/certificate'&&role!=='center')result=await pairingCertificate(input.address);
        else if(req.url==='/agent/pair'&&role!=='center')result=await control.pair(input);
        else if(req.url==='/agent/status'&&role!=='center')result=control.deviceStatus(input);
        else if(req.url==='/agent/leave'&&role!=='center')result=await control.leave(input);
        else if(req.url==='/desktop/open')result=await openDesktop();
        else if(req.url==='/stop')control.stop();else throw Error('NOT_FOUND');
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
      }finally{mutating=false;}
    }catch(e){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:e.message,...(typeof e.code==='string'?{code:e.code}:{})}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  sessionCookie='harmony_local_'+server.address().port+'='+localToken;
  const url=origin+'/#'+token;
  if(role==='center'&&options.display!==false){
    const {startDisplay}=require('./photo-display-server.cjs');
    try{display=await startDisplay({port:Number(process.env.HARMONY_DISPLAY_PORT||7460),dataDir:process.env.HARMONY_DISPLAY_DIR||path.join(os.homedir(),'HarmonyRuntime','photo-display'),coordinatorProvider:()=>control.state==='RUNNING'?{desktop:url,followCurrent:true}:null});}catch(e){control.log('展示服务未启动：'+e.message);}
    server.on('close',()=>display?.server.close());
  }
  if(options.openBrowser){if(process.platform==='win32')spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore'}).on('error',()=>console.log('请在本机浏览器打开：'+url));else console.log('请在本机浏览器打开：'+url);}
  process.on('SIGINT',()=>{control.stop();if(!control.child)server.close();else control.child.once('exit',()=>server.close());});
  return {server,control,url,display};
}
module.exports={RuntimeControl,addresses,main,pairingCertificate,resolvePairingInput,pairingRequest,deviceRequest};
if(require.main===module)main({openBrowser:true,role:process.argv[2]}).catch(e=>{console.error(e.message);process.exitCode=1;});
