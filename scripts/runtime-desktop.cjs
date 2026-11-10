// Local control surface. No LAN listener and no unauthenticated process controls.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomBytes}=require('node:crypto'),{spawn,execFileSync}=require('node:child_process');
const {lanEnvironment}=require('./start-coordinator-lan.cjs');
const {discoverCenters:discover}=require('../apps/windows-agent/discovery.cjs');
const root=path.resolve(__dirname,'..');
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
  constructor(options={}){this.dataRoot=options.dataRoot||path.join(root,'services/coordinator/data');this.child=null;this.state='STOPPED';this.logs=[];this.url=null;this.mode=null;}
  log(value){this.logs.push(value);this.logs=this.logs.slice(-100);}
  launch(script,args,env){
    if(this.child)throw Error('请先停止当前服务');
    this.state='STARTING';this.logs=[];
    const child=spawn(process.execPath,[script,...args],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});this.child=child;
    let pending='';const collect=chunk=>{pending+=chunk.toString();const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines){this.log(line);if(line.startsWith('Coordinator ready:')||line.startsWith('CPU host started:'))this.state='RUNNING';}};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    child.on('error',e=>{this.log(e.code||'PROCESS_START_FAILED');this.child=null;this.state='FAILED';});
    child.on('exit',code=>{if(pending)this.log(pending);this.child=null;this.state=code===0?'STOPPED':'FAILED';});
  }
  startCenter(input){
    if(this.child)throw Error('服务已在运行');
    const address=input.address,port=String(input.port||7443);
    // Keep each network identity in its own directory, never replace an existing certificate.
    const env=lanEnvironment(address,port,process.env.HARMONY_COORDINATOR_DATA_DIR||path.join(this.dataRoot,'desktop-'+address),{...process.env,COORDINATOR_OPENSSL:openssl()});
    if(input.suite){if(!path.isAbsolute(input.suite)||!fs.existsSync(input.suite))throw Error('协调中心的评测套件路径不存在');env.COORDINATOR_IMAGE_ENCODING_SUITE=input.suite;}
    if(!fs.existsSync(path.join(root,'services/coordinator/dist/main.js')))throw Error('请先完成协调者构建');
    this.mode='center';this.url=env.COORDINATOR_PUBLIC_URL;
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
    this.mode='agent';this.url=null;
    this.launch(path.join(root,'services/pc-agent/dist/host-main.js'),[path.join(directory,'agent.json'),path.join(directory,'contribution.json')],env);
  }
  async pair(input){
    if(this.child)throw Error('请先停止当前服务');
    if(typeof input.invitation!=='string')throw Error('请导入完整设备邀请');
    const bootstrap=JSON.parse(input.invitation),directory=deviceDirectory(input.directory);
    if(!bootstrap.invitation||!bootstrap.contribution||!bootstrap.holderInstanceId)throw Error('请导入完整设备邀请');
    if(fs.existsSync(directory))throw Error('安装目录已存在，请恢复该设备或选择新目录；不覆盖账本');
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
  deviceStatus(input){
    const directory=deviceDirectory(input.directory);
    try{
      const {connection}=JSON.parse(fs.readFileSync(path.join(directory,'agent.json'),'utf8'));
      const policy=JSON.parse(fs.readFileSync(path.join(directory,'contribution.json'),'utf8'));
      return {paired:true,address:connection.address,cpu:policy.maxCpuThreads,memory:policy.maxMemoryBytes};
    }catch(e){if(e.code==='ENOENT')return {paired:false};throw Error('设备配对记录无法读取，请检查安装目录');}
  }
  stop(){if(this.child){this.state='STOPPING';if(this.child.connected)this.child.send({type:'shutdown'},error=>{if(error)this.log('停止请求未确认，请查看进程状态');});}}
  snapshot(){return {state:this.state,mode:this.mode,url:this.url,logs:this.logs,addresses:addresses()};}
}
async function main(options={openBrowser:true}){
  process.chdir(root);const control=new RuntimeControl(),token=randomBytes(32).toString('hex');let origin='';let mutating=false;
  const role=options.role??'both';
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
    if(req.headers['x-runtime-token']!==token||req.headers.origin&&req.headers.origin!==origin){res.writeHead(403).end();return;}
    try{
      if(req.method==='GET'&&req.url==='/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...control.snapshot(),role}));return;}
      if(req.method==='GET'&&req.url==='/discover'&&role!=='center'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({centers:await discover()}));return;}
      if(req.method!=='POST'||req.headers.origin!==origin)throw Error('REQUEST_REJECTED');
      let body='';for await(const chunk of req){body+=chunk;if(body.length>32768)throw Error('REQUEST_LIMIT');}
      if(mutating)throw Error('操作进行中');mutating=true;
      try{const input=JSON.parse(body||'{}');let result={};
        if(req.url==='/center/start'&&role!=='agent')control.startCenter(input);
        else if(req.url==='/agent/start'&&role!=='center')control.startAgent(input);
        else if(req.url==='/agent/pair'&&role!=='center')result=await control.pair(input);
        else if(req.url==='/agent/status'&&role!=='center')result=control.deviceStatus(input);
        else if(req.url==='/desktop/open')result=await openDesktop();
        else if(req.url==='/stop')control.stop();else throw Error('NOT_FOUND');
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
      }finally{mutating=false;}
    }catch(e){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:e.message}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  const url=origin+'/#'+token;
  if(options.openBrowser){if(process.platform==='win32')spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore'}).on('error',()=>console.log('请在本机浏览器打开：'+url));else console.log('请在本机浏览器打开：'+url);}
  process.on('SIGINT',()=>{control.stop();if(!control.child)server.close();else control.child.once('exit',()=>server.close());});
  return {server,control,url};
}
module.exports={RuntimeControl,addresses,main};
if(require.main===module)main({openBrowser:true,role:process.argv[2]}).catch(e=>{console.error(e.message);process.exitCode=1;});
