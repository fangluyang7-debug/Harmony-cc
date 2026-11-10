import {common} from '@kit.AbilityKit';
import {ReviewRun,ReviewJob,ReviewPair,ReviewTarget} from 'scheduler';
import {VisualReviewSession,ReviewGallery} from '../VisualReviewSession';
@Entry
@Component
struct VisualReview{
 @StorageLink('visualReviewQuery') query:string='500元以内的运动鞋';
 @State busy:boolean=false;
 @State connected:boolean=false;
 @State status:string='由设备调度件承接 SoleAI 计算，保持本页前台，手机才能参与计算。';
 @State gallery:ReviewGallery|null=null;
 @State jobs:ReviewJob[]=[];
 @State pairs:ReviewPair[]=[];
 @State choices:ReviewTarget[]=[];
 @State computerId:string='';
 @State summary:string='';
 private session:VisualReviewSession|null=null;
 private context():common.UIAbilityContext{return this.getUIContext().getHostContext() as common.UIAbilityContext;}
 private async connect():Promise<void>{this.busy=true;try{if(!this.session)this.session=new VisualReviewSession(this.context());await this.session.connect();this.connected=true;this.gallery=this.session.gallery;this.choices=this.session.targets;this.computerId=this.choices[0]?.deviceId??'';this.status=this.session.status;if(this.session.runs.length)this.summary=this.session.resultView().summary;}catch(e){this.status=(e as Error).message;}finally{this.busy=false;}}
 private async acquire():Promise<void>{if(!this.session)return;this.busy=true;try{await this.session.acquire(this.query,(s:string)=>{this.status=s;});this.gallery=this.session.gallery;this.jobs=[];this.pairs=[];this.summary='';this.status='原图已保存到本手机；尚未向计算设备传输。请依次运行两种模式，不重新获取商品。';}catch(e){this.status=(e as Error).message;}finally{this.busy=false;}}
 private async run(mode:string):Promise<void>{if(!this.session)return;this.busy=true;this.pairs=[];this.summary='';try{const result=await this.session.run(mode,this.computerId,(r:ReviewRun)=>{this.jobs=r.jobs.slice();this.status=(mode==='PHONE'?'手机单机':'双机分片')+' · '+r.state+' · '+r.jobs.filter(j=>j.state==='SUCCEEDED').length+'/'+r.jobs.length;});this.pairs=result.pairs.slice().sort((a:ReviewPair,b:ReviewPair)=>b.scoreMillion-a.scoreMillion).slice(0,6);this.summary=this.session.resultView().summary;this.status=result.state==='SUCCEEDED'?'全部分片完成、结果已校验':result.error;}catch(e){this.status=(e as Error).message;}finally{this.busy=false;}}
 private async back():Promise<void>{if(!this.session||!this.summary)return;await this.context().terminateSelfWithResult({resultCode:0,want:{parameters:{reviewResult:JSON.stringify(this.session.resultView())}}});}
 build(){Scroll(){Column({space:16}){
  Text('SoleAI · 商品图像复核').fontSize(26).fontWeight(FontWeight.Bold).width('100%')
  Text('手机与电脑同时计算真实分片。计算由设备调度件前台承接，完成后返回 SoleAI。').fontSize(14).fontColor('#52617A')
  Button(this.connected?'刷新设备与恢复记录':'连接并授权图像计算').enabled(!this.busy).onClick(()=>{void this.connect();})
  TextInput({text:this.query,placeholder:'购物需求'}).enabled(!this.busy).onChange((v:string)=>{this.query=v;})
  Button('1. 获取真实商品图片').enabled(this.connected&&!this.busy).onClick(()=>{void this.acquire();})
  if(this.gallery){Text(this.gallery.products.length+' 张不同图片 · '+this.gallery.sourceRunId).fontSize(13).width('100%');Text('同一批商品可反复对照；重新获取将开启新的输入集。').fontSize(13).fontColor('#52617A')}
  Text('选择协同电脑（设备 ID 与调度盘对应）').fontSize(14).width('100%')
  ForEach(this.choices,(t:ReviewTarget)=>{Button((t.deviceId===this.computerId?'已选 · ':'选择 · ')+t.deviceId.slice(0,12)).enabled(!this.busy).onClick(()=>{this.computerId=t.deviceId;});},(t:ReviewTarget)=>t.deviceId)
  Button('2. 手机单机运行').enabled(this.connected&&this.gallery!==null&&!this.busy).onClick(()=>{void this.run('PHONE');})
  Button('3. 手机＋电脑并行运行').enabled(this.connected&&this.gallery!==null&&this.computerId.length>0&&!this.busy).onClick(()=>{void this.run('TEAM');})
  Text('双机验收模式：首分片约束到手机，其余到所选电脑；统一规划器仍负责准入、传输和派发。不是自动最优分配。每任务 30 秒，两种模式算法与输入相同。').fontSize(12).fontColor('#52617A')
  Text(this.status).fontSize(15).width('100%')
  if(this.busy){Button('停止后续分片').onClick(()=>{this.session?.cancel();this.status='停止后续提交，等待已提交任务结算；请保持本页前台';})}
  ForEach(this.jobs,(j:ReviewJob)=>{Column({space:4}){Text('分片 '+(j.index+1)+' · '+j.pairs+' 对 · '+j.state).fontWeight(FontWeight.Medium);Text((j.deviceId||'规划中')+'\n'+j.id+'\n'+j.error).fontSize(11)}.width('100%').alignItems(HorizontalAlign.Start).padding(12).backgroundColor('#EEF3FC');},(j:ReviewJob)=>j.id)
  if(this.summary){Text(this.summary).fontSize(15).width('100%');Text('外观指数仅是复核线索，不代表同款或概率。').fontSize(12).fontColor('#52617A')}
  ForEach(this.pairs,(p:ReviewPair)=>{Row({space:8}){Image('file://'+(this.gallery?.products.find(x=>x.id===p.a)?.file??'')).width(120).height(100).objectFit(ImageFit.Contain);Image('file://'+(this.gallery?.products.find(x=>x.id===p.b)?.file??'')).width(120).height(100).objectFit(ImageFit.Contain);Text((p.scoreMillion/10000).toFixed(1)).fontSize(16)}},(p:ReviewPair)=>p.a+':'+p.b)
  Button('4. 返回 SoleAI 查看结果').enabled(!this.busy&&this.summary.length>0).onClick(()=>{void this.back();})
 }.padding(24).width('100%')}.width('100%').height('100%').backgroundColor('#F7F9FC')}
}
