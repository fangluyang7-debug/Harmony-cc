import { StoredAppActivity, ExecutorV2, InFlightV2, QueuedFactV2, LinkV2, CreditV2, ResourceAmountV2, DeviceProfileV2, PoolV2, NumericSampleV2, StateSampleV2, sampleUsableV2 } from 'scheduler';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { util } from '@kit.ArkTS';
import { CoordinatorDatabase, CoordinatorOverview, CoordinatorOverviewRow, CoordinatorCertificate, createCoordinatorCertificate, CoordinatorTlsServer, CoordinatorDiscovery, CoordinatorPairing, CoordinatorRoutes, CoordinatorLocalAdmin, CoordinatorAllotments, CoordinatorGrantCrypto, CoordinatorCredentials, CoordinatorDeviceSettings, CoordinatorChannel, CoordinatorApps, CoordinatorDirectory, CoordinatorActivity } from 'scheduler';
interface RowsInput {items:CoordinatorOverviewRow[];title:string;}
@Entry
@Component
struct Index {
 @State wide:boolean=false;
 @State selected:number=0;
 @State detail:string='';
 @State snapshot:CoordinatorOverview={spaces:[],devices:[],tasks:[],apps:[]};
 private labels:string[]=['运行总览','设备资源','任务追踪','网络链路','异常恢复','设备接入','应用授权','中心设置'];
 private database:CoordinatorDatabase|null=null;
 private opening:Promise<CoordinatorDatabase>|null=null;
 private refreshTimer:number=-1;
 private refreshing:boolean=false;
 @State status:string='尚未启动';
 @State address:string='';
 @State fingerprint:string='';
 @State busy:boolean=false;
 @State running:boolean=false;
 @State deviceName:string='';
 @State activeSpace:string='';
 @State invitationText:string='';
 @State pairingCode:string='';
 @State pairingQr:string='';
 @State showInvitationDetails:boolean=false;
 @State operationStatus:string='';
 private admin:CoordinatorLocalAdmin|null=null;
 private channel:CoordinatorChannel|null=null;
 private server:CoordinatorTlsServer=new CoordinatorTlsServer();
 private discovery:CoordinatorDiscovery=new CoordinatorDiscovery();
 aboutToAppear():void{void this.refresh();this.refreshTimer=setInterval(()=>{void this.refresh();},2000);this.address=AppStorage.get<string>('coordinatorAddress')??'';if(AppStorage.get<boolean>('coordinatorAutoStart'))void this.start();}
 aboutToDisappear():void{if(this.refreshTimer!==-1)clearInterval(this.refreshTimer);this.refreshTimer=-1;}
 private async openDatabase():Promise<CoordinatorDatabase>{
  if(this.database)return this.database;
  if(this.opening===null)this.opening=CoordinatorDatabase.open(getContext(this) as common.UIAbilityContext);
  try{this.database=await this.opening;return this.database;}finally{this.opening=null;}
 }
 private async start():Promise<void>{
  if(this.busy||this.running)return;this.busy=true;
  try{
   const context=getContext(this) as common.UIAbilityContext;
   this.status='正在打开协调中心数据库';const db=await this.openDatabase();this.snapshot=await db.overview();
   const storage=await preferences.getPreferences(context,{name:'coordinator-identity'});
   let id=await storage.get('id','') as string;if(!id){id=util.generateRandomUUID(true);await storage.put('id',id);await storage.flush();}
   this.status='正在生成设备证书';const raw=await storage.get('certificate','') as string,addresses=this.address.trim()?[this.address.trim()]:[];
   const identity:CoordinatorCertificate=raw?JSON.parse(raw) as CoordinatorCertificate:await createCoordinatorCertificate(addresses);
   if(!raw){await storage.put('certificate',JSON.stringify(identity));await storage.flush();}
   this.fingerprint=identity.fingerprint;const epoch=await db.startEpoch(id);
   const address='https://'+this.address.trim()+':7443';
   const pairing=new CoordinatorPairing(db,identity,'REAL'),routes=new CoordinatorRoutes(pairing,identity,address,epoch);
   const credentials=new CoordinatorCredentials(db,'REAL'),allotments=new CoordinatorAllotments(db,await CoordinatorGrantCrypto.create(identity.privateKey),epoch);routes.installAllotments(credentials,allotments);routes.installDeviceSettings(new CoordinatorDeviceSettings(db,allotments));
   routes.installApps(new CoordinatorApps(db,identity,address));
   routes.installDirectory(new CoordinatorDirectory(db));routes.installActivity(new CoordinatorActivity(db));
   const channel=new CoordinatorChannel(db,credentials,id,epoch);this.channel=channel;routes.installIdentity(id);this.server.installChannel((request,connection)=>channel.upgrade(request,connection));pairing.onRevoked(credentialId=>channel.revoke(credentialId));
   this.admin=new CoordinatorLocalAdmin(db,pairing,'local-'+id,address);
   this.activeSpace=await this.admin.ensureDefaultSpace();this.snapshot=await db.overview();
   await this.server.start(identity,7443,request=>routes.handle(request));
   if(this.address.trim())await this.discovery.start('https://'+this.address.trim()+':7443');
   hilog.info(0x0001,'HarmonyCoordinator','TLS_LISTENING epoch=%{public}d fingerprint=%{public}s',epoch,identity.fingerprint);
   this.running=true;this.status='配对服务与数据库已启动 · epoch '+epoch+'\n任务调度协议仍在移植';
  }catch(e){await this.discovery.close().catch(()=>{});await this.channel?.close().catch(()=>{});await this.server.close().catch(()=>{});this.status=(e as Error).message;hilog.error(0x0001,'HarmonyCoordinator','START_FAILED %{public}s',this.status);}finally{this.busy=false;}
 }
 private async refresh():Promise<void>{
  if(this.refreshing)return;this.refreshing=true;
  try{const db=await this.openDatabase();this.snapshot=await db.overview();}catch(e){this.status=(e as Error).message;}finally{this.refreshing=false;}
 }
 private async inviteDevice():Promise<void>{
  if(!this.admin||!this.running||this.busy)return;this.busy=true;
  try{const result=await this.admin.inviteDevice(this.activeSpace,this.deviceName);this.pairingCode=result.pairing.pairingCode;this.pairingQr=result.qrPayload;this.showInvitationDetails=false;this.invitationText=JSON.stringify(result.bootstrap);this.operationStatus='二维码与配对码五分钟内有效，配对完成后邀请失效';await this.refresh();}catch(e){this.operationStatus=(e as Error).message;}finally{this.busy=false;}
 }
 @Builder
 spaceControls(){
  Column({space:14}){
   Text('邀请设备').fontSize(20).fontColor('#173252')
   Text('设备与本协调中心配对后自动加入同一协作空间。').fontSize(14).fontColor('#64748B')
   TextInput({text:this.deviceName,placeholder:'设备名称'}).onChange(value=>{this.deviceName=value;})
   Button(this.pairingQr?'生成新的接入邀请':'生成配对二维码').enabled(this.running&&!this.busy&&!!this.activeSpace&&!!this.deviceName.trim()).onClick(()=>{void this.inviteDevice();})
   if(this.pairingQr){
    Column({space:12}){
     Text('使用节点应用扫描二维码').fontSize(16).fontColor('#173252')
     Column(){QRCode(this.pairingQr).width(220).height(220).color('#000000').backgroundColor('#FFFFFF')}.padding(20).backgroundColor('#FFFFFF')
     Text('也可输入六位配对码').fontSize(14).fontColor('#64748B')
     Text(this.pairingCode).fontSize(36).fontWeight(FontWeight.Bold).copyOption(CopyOptions.LocalDevice)
    }.width('100%')
    Text('请让节点与协调中心连接到可互访的同一网络').fontSize(13).fontColor('#64748B')
    Button(this.showInvitationDetails?'收起接入配置':'查看接入配置').fontSize(13).onClick(()=>{this.showInvitationDetails=!this.showInvitationDetails;})
    if(this.showInvitationDetails){Text(this.pairingQr).fontSize(12).copyOption(CopyOptions.LocalDevice);Text(this.invitationText).fontSize(12).copyOption(CopyOptions.LocalDevice)}
   }
   Text(this.operationStatus||(this.running?'输入设备名称，生成配对码':'请先在中心设置中启动服务')).fontSize(14).fontColor('#64748B')
  }.alignItems(HorizontalAlign.Start).padding(22).width('100%').backgroundColor('#FFFFFF').borderRadius(16)
 }
 @Builder
 navigation(){
  ForEach(this.labels,(label:string,index:number)=>{
   Button(label).type(ButtonType.Normal).fontSize(15).fontColor(this.selected===index?'#FFFFFF':'#B9C9E0')
    .backgroundColor(this.selected===index?'#2459A5':'#102139').borderRadius(10).width(this.wide?'100%':108).height(46)
    .onClick(()=>{this.selected=index;this.detail='';void this.refresh();})
  })
 }
 @Builder
 card(title:string,value:string,caption:string){
  Column({space:10}){Text(title).fontSize(14).fontColor('#64748B');Text(value).fontSize(30).fontWeight(FontWeight.Bold).fontColor('#173252');Text(caption).fontSize(12).fontColor('#64748B')}
  .alignItems(HorizontalAlign.Start).padding(20).width('100%').backgroundColor('#FFFFFF').borderRadius(16)
 }
 @Builder
 empty(title:string,description:string){
  Column({space:12}){Text(title).fontSize(20).fontWeight(FontWeight.Medium).fontColor('#173252');Text(description).fontSize(15).fontColor('#64748B').lineHeight(23)}
   .alignItems(HorizontalAlign.Start).padding(24).width('100%').backgroundColor('#FFFFFF').borderRadius(16)
 }
 private sampleText(sample:NumericSampleV2|StateSampleV2):string{
  if(!sampleUsableV2(sample,Date.now(),'REAL')||sample.sampledAt+sample.ttlMs<=Date.now())return 'UNKNOWN';
  if(sample.unit==='bytes'){
   const value=sample.value as number;
   if(value>=1073741824)return (value/1073741824).toFixed(2)+' GiB';
   if(value>=1048576)return (value/1048576).toFixed(1)+' MiB';
   if(value>=1024)return (value/1024).toFixed(1)+' KiB';
   return String(value)+' B';
  }
  return String(sample.value)+(sample.unit==='slots'?' 槽位':sample.unit==='percent'?'%':sample.unit==='level'?' 级':'');
 }
 private amount(value:number,unit:string):string{return unit==='bytes'?(value/1048576).toFixed(1)+' MiB':String(value)+' 槽位';}
 private remaining(pool:PoolV2):string{if(this.sampleText(pool.occupied)==='UNKNOWN'||this.sampleText(pool.admissionLimit)==='UNKNOWN')return 'UNKNOWN';return this.amount(Math.max(0,pool.admissionLimit.value!-pool.occupied.value!),pool.total.unit);}
 private utilization(pool:PoolV2):number{if(this.sampleText(pool.occupied)==='UNKNOWN'||this.sampleText(pool.admissionLimit)==='UNKNOWN'||!pool.admissionLimit.value)return 0;return Math.min(100,100*pool.occupied.value!/pool.admissionLimit.value);}
 private evidence(sample:NumericSampleV2):string{return sample.source+' · '+new Date(sample.sampledAt).toLocaleTimeString()+' · 有效期 '+sample.ttlMs+' ms · '+(this.sampleText(sample)==='UNKNOWN'?'未知或过期':'有效');}
 private resourceVector(resources:ResourceAmountV2[]):string{return resources.map(r=>r.resourcePoolId+' '+(r.resourcePoolId==='ram'||r.resourcePoolId==='vram'?this.amount(r.amount,'bytes'):String(r.amount))).join(' · ');}
 @Builder
 resources(profile:DeviceProfileV2){
  Column({space:12}){
   Text('HOLDER '+profile.holderInstanceId+' · seq '+profile.sequence+' / ledger '+profile.ledgerEpoch).fontSize(12).fontColor('#64748B')
   GridRow({columns:this.wide?3:1,gutter:12}){
    GridCol(){this.card('所有者活动',this.sampleText(profile.ownerActivity),'设备上报')}
    GridCol(){this.card('电量',this.sampleText(profile.battery),'设备上报')}
    GridCol(){this.card('温度 / 热等级',this.sampleText(profile.temperature),'设备上报')}
   }
   ForEach(profile.pools,(pool:PoolV2)=>{
    Column({space:8}){
     Text(pool.kind==='RAM_BYTES'?'内存额度':pool.kind==='CPU_SLOTS'?'CPU 协同槽位':pool.kind).fontSize(17).fontColor('#173252')
     Text(this.sampleText(pool.occupied)+' / '+this.sampleText(pool.admissionLimit)).fontSize(24).fontWeight(FontWeight.Medium).fontColor('#173252')
     Text('任务占用 / 准入上限 · 上报总量 '+this.sampleText(pool.total)).fontSize(13).fontColor('#64748B')
     Progress({value:this.utilization(pool),total:100,type:ProgressType.Linear}).width('100%')
     Text('剩余可分配 '+this.remaining(pool)+' · '+(pool.draining?'正在排空':'未排空')).fontSize(14).fontColor('#173252')
     Text('贡献上限 '+this.amount(pool.contributionLimit,pool.total.unit)+' · 系统预留 '+this.amount(pool.ownerReserved,pool.total.unit)).fontSize(13).fontColor('#64748B')
     Text('总量 '+this.evidence(pool.total)+'\n准入 '+this.evidence(pool.admissionLimit)+'\n占用 '+this.evidence(pool.occupied)).fontSize(12).fontColor('#64748B')
    }.alignItems(HorizontalAlign.Start).padding(16).width('100%').backgroundColor('#F0F4FA').borderRadius(12)
   },(pool:PoolV2)=>pool.resourcePoolId)
   Text('执行能力 · '+profile.executors.length).fontSize(20).fontWeight(FontWeight.Medium)
   ForEach(profile.executors,(executor:ExecutorV2)=>{
    Column({space:8}){
     Text(executor.target.backend+' / '+executor.contract.capability).fontSize(17).fontWeight(FontWeight.Medium)
     Text('执行器 '+executor.target.executorId+' · '+executor.target.executorVersion).fontSize(13)
     Text('目标 '+executor.target.targetId).fontSize(12)
     Text('任务资源需求 '+this.resourceVector(executor.resources)).fontSize(14)
     Text('计算 '+this.sampleText(executor.compute)+' · 排队 '+this.sampleText(executor.queue)+' · 冷启动 '+this.sampleText(executor.cold)).fontSize(13)
     Text('结果发布 '+this.sampleText(executor.publish)+' · 不确定性 '+this.sampleText(executor.uncertainty)).fontSize(13)
     Text('资格状态：待协调中心评测证据确认').fontSize(13).fontColor('#9A650B')
    }.alignItems(HorizontalAlign.Start).padding(16).width('100%').backgroundColor('#EEF4FC').borderRadius(12)
   },(executor:ExecutorV2)=>executor.target.targetId)
   Text('在途任务 '+(profile.inFlight?.length??0)+' · 等待任务 '+(profile.queued?.length??0)).fontSize(19)
   ForEach(profile.inFlight??[],(task:InFlightV2)=>{
    Text(task.attemptId+' · '+task.state+'\n'+this.resourceVector(task.resources)+'\n已运行 '+this.sampleText(task.elapsed)+' · 预计剩余 '+this.sampleText(task.remaining)).fontSize(14).width('100%')
   },(task:InFlightV2)=>task.attemptId)
   ForEach(profile.queued??[],(task:QueuedFactV2)=>{
    Text(task.attemptId+' · '+task.reason+'\n'+this.resourceVector(task.resources)+' · 已等待 '+this.sampleText(task.elapsed)).fontSize(14).width('100%')
   },(task:QueuedFactV2)=>task.attemptId)
   Text('网络方向证据 · '+profile.links.length).fontSize(19)
   ForEach(profile.links,(link:LinkV2)=>{
    Text(link.from+' → '+link.to+'\n固定延迟 '+this.sampleText(link.fixedMs)+' · 速率 '+this.sampleText(link.bytesPerSecond)).fontSize(13)
   },(link:LinkV2)=>link.from+':'+link.to+':'+link.networkEpoch)
   Text('接单窗口').fontSize(19)
   ForEach(profile.credits,(credit:CreditV2)=>{Text(credit.priority+' · '+credit.slots+' 个接单窗口').fontSize(14)},(credit:CreditV2)=>credit.priority)
   Text('前后台 '+this.sampleText(profile.foreground)+' · 充电 '+this.sampleText(profile.charging)+' · 省电 '+this.sampleText(profile.powerSave)+(profile.energyGate?' · 暂停原因 '+profile.energyGate:'')).fontSize(13)

  }.alignItems(HorizontalAlign.Start).width('100%')
 }
 @Builder
 rows($$:RowsInput){
  if($$.items.length===0){this.empty($$.title,'当前本地协调中心暂无记录。连接与调度服务接通后显示真实数据。')}
  else{
   ForEach($$.items,(item:CoordinatorOverviewRow)=>{
    Column({space:10}){
     Row(){Text(item.title).fontSize(18).fontWeight(FontWeight.Medium).fontColor('#173252').layoutWeight(1);Text(item.state).fontSize(12).fontColor('#9A650B').margin({left:12})}.width('100%')
     Text(item.detail).fontSize(13).fontColor('#64748B').width('100%')
     if(item.activities){
      ForEach(item.activities,(activity:StoredAppActivity)=>{
       this.card('应用实测 CPU',activity.activity.processCpuUsage===undefined||activity.activity.processCpuUsage===null?'UNKNOWN':(activity.activity.processCpuUsage*100).toFixed(2)+'%','进程实测 CPU 使用率 · 不等于调度槽位占用')
       Text('采样时间 '+new Date(activity.activity.sampledAt).toLocaleTimeString()).fontSize(12).fontColor('#64748B')
       this.card('应用实测内存（PSS）',activity.activity.processMemoryBytes===null?'UNKNOWN':(activity.activity.processMemoryBytes/1048576).toFixed(1)+' MiB','应用整体进程内存 · 每 2 秒更新')
       Text('运行中的应用任务 '+activity.activity.tasks.filter(t=>t.state==='RUNNING').length).fontSize(15).fontColor('#173252')
      },(activity:StoredAppActivity)=>activity.holderInstanceId+':'+activity.receivedAt)
     }
     Text(item.id).fontSize(12).fontColor('#64748B').width('100%')
     if(item.profiles){ForEach(item.profiles,(profile:DeviceProfileV2)=>{this.resources(profile)},(profile:DeviceProfileV2)=>JSON.stringify(profile))}
     Button('查看记录').fontSize(13).backgroundColor('#EAF1FB').fontColor('#2459A5').onClick(()=>{this.detail=item.title+'\n'+item.id+'\n'+item.detail+'\n状态：'+item.state;})
    }.alignItems(HorizontalAlign.Start).padding(20).width('100%').backgroundColor('#FFFFFF').borderRadius(16)
   },(item:CoordinatorOverviewRow)=>JSON.stringify(item))
  }
 }
 @Builder
 content(){
  Column({space:18}){
   Row(){Column({space:8}){Text('HARMONY / COORDINATOR').fontSize(12).fontColor('#64748B');Text(this.labels[this.selected]).fontSize(this.wide?32:26).fontWeight(FontWeight.Bold).fontColor('#173252')}.alignItems(HorizontalAlign.Start).layoutWeight(1)
    Button('刷新').fontSize(14).backgroundColor('#E3ECFA').fontColor('#2459A5').onClick(()=>{void this.refresh();})
   }.width('100%')
   Text(this.running?'本地服务已启动 · 调度功能正在接入':'本地协调中心 · 服务尚未启动').fontSize(13).fontColor('#94600C').padding(14).width('100%').backgroundColor('#FFF5DD').borderRadius(10)
   if(this.selected===0){
    GridRow({columns:this.wide?3:1,gutter:14}){
     GridCol(){this.card('在线设备',String(this.snapshot.devices.length),'控制连接在线 · 前台画像有效')}
     GridCol(){this.card('任务记录',String(this.snapshot.tasks.length),'最近 100 条执行记录')}
     GridCol(){this.card('在线宿主',String(this.snapshot.devices.reduce((count:number,row:CoordinatorOverviewRow)=>count+(row.profiles?.length??0),0)),'离线与后台宿主暂不展示')}
    }
    this.empty('设备协同拓扑','等待有效设备画像与控制链路；未知资源不计入可调度额度。')
    Text('最近执行').fontSize(20).fontWeight(FontWeight.Bold).fontColor('#173252').width('100%')
    this.rows({items:this.snapshot.tasks.slice(0,5),title:'暂无执行记录'})
   }else if(this.selected===1){
    this.empty('物理设备与应用宿主','运行内存、实时可分配额度、任务占用分别展示。离线与后台宿主暂不展示，重新上线后自动恢复。')
    this.rows({items:this.snapshot.devices,title:'暂无在线前台设备'})
   }else if(this.selected===2){this.rows({items:this.snapshot.tasks,title:'暂无任务追踪'})}
   else if(this.selected===3){this.empty('网络与数据传输','方向探测、端点和传输回执尚未接入本地服务。暂无数据不表示设备之间已经可达。')}
   else if(this.selected===4){this.rows({items:this.snapshot.tasks.filter(item=>['FAILED','REJECTED','CANCEL_REQUESTED','YIELDED'].includes(item.state)),title:'暂无已记录异常'})}
   else if(this.selected===5){this.spaceControls();this.rows({items:this.snapshot.devices,title:'暂无在线前台设备'})}
   else if(this.selected===6){this.rows({items:this.snapshot.apps,title:'暂无应用授权'});this.empty('资源由协调中心分配','应用声明能力与工作流，CPU 和内存额度由设备状态与统一资源账本确定。')}
   else{
    Column({space:16}){
     Text('本机服务').fontSize(20).fontWeight(FontWeight.Bold).fontColor('#173252')
     TextInput({text:this.address,placeholder:'局域网 IPv4 地址'}).enabled(!this.running&&!this.busy).onChange(v=>{this.address=v;})
     Button(this.busy?'正在启动…':'启动服务').enabled(!this.running&&!this.busy).width('100%').onClick(()=>{void this.start();})
     Button('停止服务').enabled(this.running).width('100%').onClick(()=>{void this.discovery.close().then(()=>this.channel?.close()).then(()=>this.server.close()).then(()=>{this.running=false;this.status='服务已停止';});})
     Text(this.status).fontSize(14).fontColor('#64748B').width('100%')
     if(this.fingerprint){Text('证书指纹').fontSize(13).fontColor('#64748B');Text(this.fingerprint).fontSize(12).fontColor('#173252').copyOption(CopyOptions.LocalDevice)}
    }.alignItems(HorizontalAlign.Start).padding(22).width('100%').backgroundColor('#FFFFFF').borderRadius(16)
   }
   if(this.detail){Column({space:12}){Text('记录详情').fontSize(20).fontWeight(FontWeight.Bold);Text(this.detail).fontSize(14).copyOption(CopyOptions.LocalDevice);Button('收起详情').onClick(()=>{this.detail='';})}.padding(20).width('100%').backgroundColor('#E3ECFA').borderRadius(16)}
  }.alignItems(HorizontalAlign.Start).padding(this.wide?32:18).width('100%')
 }
 build(){
  Column(){
   Row(){
    if(this.wide){Column({space:10}){Text('智调鸿枢').fontSize(26).fontWeight(FontWeight.Bold).fontColor('#FFFFFF').margin({bottom:8});Text('调度观测 / OBSERVE').fontSize(12).fontColor('#91A7C4').margin({bottom:24});this.navigation();Blank();Text('多端资源 · 统一协调').fontSize(14).fontColor('#91A7C4')}.padding(22).width(232).height('100%').backgroundColor('#102139')}
    Scroll(){this.content()}.layoutWeight(1).height('100%').align(Alignment.Top)
   }.layoutWeight(1).width('100%')
   if(!this.wide){Scroll(){Row({space:8}){this.navigation()}.padding(10)}.scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).height(66).width('100%').backgroundColor('#102139')}
  }.width('100%').height('100%').backgroundColor('#F0F4FA').onAreaChange((oldArea:Area,newArea:Area)=>{this.wide=Number(newArea.width)>=900;})
 }
}
