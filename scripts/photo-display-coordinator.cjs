// Read-only observer of the existing local launcher's authenticated photo APIs.
// No SDK submission, input upload, dispatch, or task cancellation lives here.
const crypto=require('node:crypto');
const idPattern=/^[a-f0-9-]{36}$/;
class PhotoCoordinatorObserver{
 constructor(){this.connection=null;this.runs=[];this.devices=[];this.spaces=[];this.error='';this.checkedAt=0;this.pending=null;}
 async connect(launcher,group,followCurrent=false){
  const url=new URL(launcher);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.pathname!=='/'||url.username||url.password||!/^#[a-f0-9]{64}$/.test(url.hash))throw Error('请粘贴本机协调中心启动器的完整地址（包含 # 后的连接信息）');
  const response=await fetch(url.origin+'/console/session',{method:'POST',headers:{Origin:url.origin,'X-Runtime-Token':url.hash.slice(1)},redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw Error('协调中心会话未建立，请先启动中心，再粘贴启动器的完整地址');
  const cookie=response.headers.get('set-cookie')?.split(';')[0];if(!cookie)throw Error('协调中心未返回本机会话');
  const connection={origin:url.origin,cookie,group:'',followCurrent};
  if(followCurrent)group=(await this.request('/console/workspace',connection)).id;
  const account=await this.request('/v2/spaces/me',connection),space=account.spaces?.find(s=>s.id===group)??(!group?account.spaces?.[0]:null);
  if(!space||!idPattern.test(space.id))throw Error('协作空间不存在');
  connection.group=space.id;connection.name=space.name;this.connection=connection;this.spaces=account.spaces;this.runs=[];this.devices=[];this.checkedAt=0;this.error='';await this.refresh();return this.status();
 }
 async request(route,connection=this.connection,binary=false){
  if(!connection)throw Error('尚未连接协调中心');
  const response=await fetch(connection.origin+route,{headers:{Cookie:connection.cookie},redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw Error(response.status===403?'协调中心会话失效，请重新连接':'协调中心暂不可用（'+response.status+'）');
  return binary?Buffer.from(await response.arrayBuffer()):response.json();
 }
 base(){return '/v2/spaces/'+this.connection.group+'/photo-runs';}
 status(){return {connected:!!this.connection&&!this.error,configured:!!this.connection,group:this.connection?.group??'',name:this.connection?.name??'',error:this.error,checkedAt:this.checkedAt};}
 async refresh(){
  if(!this.connection||Date.now()-this.checkedAt<1200)return;
  if(this.pending)return this.pending;
  this.pending=(async()=>{try{
   if(this.connection.followCurrent){const current=await this.request('/console/workspace');if(current.id!==this.connection.group){this.runs=[];this.devices=[];this.connection.group=current.id;}this.connection.name=current.name;}
   const [runs,directory]=await Promise.all([this.request(this.base()),this.request(this.base()+'/directory')]);
   this.runs=runs;this.devices=directory.devices??[];this.error='';
  }catch(e){this.error=e.message;}finally{this.checkedAt=Date.now();this.pending=null;}})();return this.pending;
 }
 async run(id){if(!idPattern.test(id)||!this.runs.some(r=>r.id===id))throw Error('RUN_NOT_FOUND');return this.request(this.base()+'/'+id);}
 async image(id,index,kind){
  if(!idPattern.test(id)||!this.runs.some(r=>r.id===id)||!Number.isInteger(index)||index<0||index>7||!['input','result'].includes(kind))throw Error('IMAGE_NOT_FOUND');
  if(kind==='input')return {bytes:await this.request(this.base()+'/'+id+'/input?image='+index,undefined,true),type:'image/png'};
  const product=await this.request(this.base()+'/'+id+'/result?image='+index),bytes=Buffer.from(product.image,'base64');
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==product.hash)throw Error('RESULT_INTEGRITY');
  return {bytes,type:'image/png'};
 }
}
module.exports={PhotoCoordinatorObserver};
