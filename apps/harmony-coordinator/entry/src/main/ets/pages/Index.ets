import { StoredAppActivity, ExecutorV2, InFlightV2, QueuedFactV2, LinkV2, CreditV2, ResourceAmountV2, DeviceProfileV2, PoolV2, NumericSampleV2, StateSampleV2, sampleUsableV2 } from 'scheduler';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { util } from '@kit.ArkTS';
import { coordinatorNetworks, CoordinatorPhoto } from 'scheduler';
import { webview } from '@kit.ArkWeb';
import { PhotoDisplayServer } from '../PhotoDisplayServer';
import { CoordinatorDatabase, CoordinatorOverview, CoordinatorOverviewRow, CoordinatorCertificate, createCoordinatorCertificate, CoordinatorTlsServer, CoordinatorDiscovery, CoordinatorPairing, CoordinatorRoutes, CoordinatorLocalAdmin, CoordinatorAllotments, CoordinatorGrantCrypto, CoordinatorCredentials, CoordinatorDeviceSettings, CoordinatorChannel, CoordinatorApps, CoordinatorDirectory, CoordinatorActivity, CoordinatorArtifacts, CoordinatorQualification, CoordinatorJobs } from 'scheduler';
interface RowsInput {items:CoordinatorOverviewRow[];title:string;}
@Entry
@Component
struct Index {
 @State wide:boolean=false;
 @State home:boolean=true;
 @State displayPage:boolean=false;
 private displayController:webview.WebviewController=new webview.WebviewController();
 private displayServer:PhotoDisplayServer|null=null;
 @State selected:number=0;
 @State detail:string='';
 @State snapshot:CoordinatorOverview={spaces:[],devices:[],tasks:[],apps:[]};
 private labels:string[]=['运行总览','设备资源','任务追踪','网络链路','异常恢复','设备接入','应用授权','中心设置'];
 private onlineDevices():CoordinatorOverviewRow[]{return this.snapshot.devices.filter(d=>d.state==='在线');}
 private recentWork(device:string):CoordinatorOverviewRow[]{return this.snapshot.tasks.filter(t=>t.kind==='DISPATCH'&&t.deviceId===device).slice(0,5);}
 private metric(value:number|null,unit:string):string{return value===null?'未提供':value.toFixed(1)+unit;}
 private powerText(status:string):string{const labels:Record<string,string>={'NO_BATTERY':'无电池 · 不适用','CHARGING':'正在充电','DISCHARGING':'电池供电','AC_POWER':'外接电源','UNKNOWN':'系统未提供供电状态'};return labels[status]??status;}
 private taskState(state:string):string{const labels:Record<string,string>={'WAITING_INPUT':'等待输入','OFFERED':'已派发','ACCEPTED':'已接单','RUNNING':'处理中','SUCCEEDED':'已完成','FAILED':'失败','CANCELLED_SETTLED':'已取消并结算','CANCEL_REQUESTED':'正在取消','TIMED_OUT':'超时'};return labels[state]??state;}
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
 @State invitationRemaining:number=0;
 private invitationExpiresAt:number=0;
 @State pairingQr:string='';
 @State showInvitationDetails:boolean=false;
 @State operationStatus:string='';
 private admin:CoordinatorLocalAdmin|null=null;
 private channel:CoordinatorChannel|null=null;
 private jobs:CoordinatorJobs|null=null;
 private photo:CoordinatorPhoto|null=null;
 private server:CoordinatorTlsServer=new CoordinatorTlsServer();
 private discovery:CoordinatorDiscovery=new CoordinatorDiscovery();
 aboutToAppear():void{void this.refresh();this.refreshTimer=setInterval(()=>{void this.refresh();},2000);if(AppStorage.get<boolean>('coordinatorAutoStart'))void this.start();}
 aboutToDisappear():void{if(this.refreshTimer!==-1)clearInterval(this.refreshTimer);this.refreshTimer=-1;}
 private async openDatabase():Promise<CoordinatorDatabase>{
  if(this.database)return this.database;
  if(this.opening===null)this.opening=CoordinatorDatabase.open(getContext(this) as common.UIAbilityContext);
  try{this.database=await this.opening;return this.database;}finally{this.opening=null;}
 }
 private async start():Promise<void>{
  if(this.busy||this.running)return;this.busy=true;
  try{
   this.status='正在识别局域网';const networks=await coordinatorNetworks();
   if(networks.length===0)throw Error('未检测到可用局域网，请连接 Wi-Fi 或网线后重新启动');
   this.address=networks.some(n=>n.address===this.address)?this.address:networks[0].address;
   const context=getContext(this) as common.UIAbilityContext;
   this.status='正在打开协调中心数据库';const db=await this.openDatabase();this.snapshot=await db.overview();
   const storage=await preferences.getPreferences(context,{name:'coordinator-identity'});
   let id=await storage.get('id','') as string;if(!id){id=util.generateRandomUUID(true);await storage.put('id',id);await storage.flush();}
   this.status='正在生成设备证书';const raw=await storage.get('certificate','') as string,addresses=networks.map(n=>n.address);
   const previous:CoordinatorCertificate|null=raw?JSON.parse(raw) as CoordinatorCertificate:null;
   const renew=previous===null||previous.ipAddresses===undefined||addresses.some(address=>!previous.ipAddresses?.includes(address));
   const identity:CoordinatorCertificate=renew?await createCoordinatorCertificate(addresses):previous as CoordinatorCertificate;
   if(renew){await storage.put('certificate',JSON.stringify(identity));await storage.flush();if(previous!==null)this.operationStatus='网络地址已变更，服务证书已更新；请生成新的邀请并重新配对设备';}
   this.fingerprint=identity.fingerprint;const epoch=await db.startEpoch(id);
   const address='https://'+this.address.trim()+':7443';
   const pairing=new CoordinatorPairing(db,identity,'REAL'),routes=new CoordinatorRoutes(pairing,identity,address,epoch);
   const credentials=new CoordinatorCredentials(db,'REAL'),allotments=new CoordinatorAllotments(db,await CoordinatorGrantCrypto.create(identity.privateKey),epoch);routes.installAllotments(credentials,allotments);routes.installDeviceSettings(new CoordinatorDeviceSettings(db,allotments));
   routes.installApps(new CoordinatorApps(db,identity,address));
   routes.installDirectory(new CoordinatorDirectory(db));routes.installActivity(new CoordinatorActivity(db));
   const channel=new CoordinatorChannel(db,credentials,id,epoch);this.channel=channel;routes.installIdentity(id);this.server.installChannel((request,connection)=>channel.upgrade(request,connection));pairing.onRevoked(credentialId=>channel.revoke(credentialId));
   const artifacts=new CoordinatorArtifacts(db,credentials),packBytes=await context.resourceManager.getRawFileContent('reference-packs.json');
   const qualification=new CoordinatorQualification(db,util.TextDecoder.create('utf-8').decodeToString(packBytes),epoch);
   const jobs=new CoordinatorJobs(db,channel,artifacts,qualification,id,epoch);this.jobs=jobs;routes.installExecution(db,artifacts,qualification,jobs);
   this.photo=new CoordinatorPhoto(db,artifacts,jobs,util.TextDecoder.create('utf-8').decodeToString(packBytes));routes.installPhoto(this.photo);
   qualification.onChanged=(group,holder)=>{void channel.evaluationChanged(group,holder).catch(()=>{});};channel.onProfile=qualification.onChanged;
   this.admin=new CoordinatorLocalAdmin(db,pairing,'local-'+id,address);
   this.activeSpace=await this.admin.ensureDefaultSpace();this.snapshot=await db.overview();
   await this.server.start(identity,7443,request=>routes.handle(request));
   this.displayServer=new PhotoDisplayServer(context,this.photo,db,'http://'+this.address+':7460');await this.displayServer.start();
   if(this.address.trim())await this.discovery.start('https://'+this.address.trim()+':7443');
   hilog.info(0x0001,'HarmonyCoordinator','TLS_LISTENING epoch=%{public}d fingerprint=%{public}s',epoch,identity.fingerprint);
   jobs.start();await this.photo.start();this.running=true;this.status='配对服务与数据库已启动 · epoch '+epoch+'\n任务派发与回执服务已启动';
  }catch(e){this.photo?.close();await this.displayServer?.close().catch(()=>{});this.jobs?.close();await this.discovery.close().catch(()=>{});await this.channel?.close().catch(()=>{});await this.server.close().catch(()=>{});this.status=(e as Error).message;hilog.error(0x0001,'HarmonyCoordinator','START_FAILED %{public}s',this.status);}finally{this.busy=false;}
 }
 private async stop():Promise<void>{
  if(this.busy||!this.running)return;this.busy=true;
  try{this.photo?.close();await this.displayServer?.close();this.jobs?.close();await this.discovery.close();await this.channel?.close();await this.server.close();this.running=false;this.admin=null;this.status='服务已停止';this.pairingQr='';this.pairingCode='';this.invitationText='';this.invitationExpiresAt=0;}
  catch(e){this.status='停止未完成：'+(e as Error).message;}finally{this.busy=false;}
 }
 private async refresh():Promise<void>{
  if(this.invitationExpiresAt>0){this.invitationRemaining=Math.max(0,Math.ceil((this.invitationExpiresAt-Date.now())/1000));if(this.invitationRemaining===0){this.pairingQr='';this.pairingCode='';this.invitationText='';this.invitationExpiresAt=0;this.operationStatus='配对邀请已过期，请生成新的二维码或配对码';}}
  if(this.refreshing)return;this.refreshing=true;
  try{const db=await this.openDatabase();this.snapshot=await db.overview();}catch(e){this.status=(e as Error).message;}finally{this.refreshing=false;}
 }
 private async inviteDevice():Promise<void>{
  if(!this.admin||!this.running||this.busy)return;this.busy=true;
  try{const result=await this.admin.inviteDevice(this.activeSpace,this.deviceName);this.invitationExpiresAt=result.pairing.pairingCodeExpiresAt;this.invitationRemaining=Math.max(0,Math.ceil((this.invitationExpiresAt-Date.now())/1000));this.pairingCode=result.pairing.pairingCode;this.pairingQr=result.qrPayload;this.showInvitationDetails=false;this.invitationText=JSON.stringify(result.bootstrap);this.operationStatus='五分钟内有效，原设备退出后可使用同一邀请重新加入';await this.refresh();}catch(e){this.operationStatus=(e as Error).message;}finally{this.busy=false;}
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
     Text('有效期剩余 '+this.invitationRemaining+' 秒 · 也可输入六位配对码').fontSize(14).fontColor('#64748B')
     Text(this.pairingCode).fontSize(36).fontWeight(FontWeight.Bold).copyOption(CopyOptions.LocalDevice)
    }.width('100%')
    Text('请让节点与协调中心连接到可互访的同一网络').fontSize(13).fontColor('#64748B')
    Button(this.showInvitationDetails?'收起接入配置':'查看接入配置').fontSize(13).onClick(()=>{this.showInvitationDetails=!this.showInvitationDetails;})
    if(this.showInvitationDetails){Text(this.pairingQr).fontSize(12).copyOption(CopyOptions.LocalDevice);Text(this.invitationText).fontSize(12).copyOption(CopyOptions.LocalDevice)}
   }
   Text(this.operationStatus||(this.running?'输入设备名称，生成配对码':'请先返回首页启动协调中心')).fontSize(14).fontColor('#64748B')
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
 private qualificationText(holder:string,target:string):string{
  for(const row of this.snapshot.devices){const admission=row.qualifications?.find(q=>q.holderInstanceId===holder&&q.targetId===target);if(admission)return admission.state+' · '+admission.reasonCode;}
  return '等待评测';
 }
 @Builder
 resources(profile:DeviceProfileV2){
  Column({space:12}){
   Text('HOLDER '+profile.holderInstanceId+' · seq '+profile.sequence+' / ledger '+profile.ledgerEpoch).fontSize(12).fontColor('#64748B')
   GridRow({columns:this.wide?3:1,gutter:12}){
    GridCol(){this.card('所有者活动',this.sampleText(profile.ownerActivity),'设备上报')}
    if(!this.snapshot.devices.find(d=>d.id===profile.deviceId)?.telemetry){GridCol(){this.card('电量',this.sampleText(profile.battery)==='UNKNOWN'?'未提供':this.sampleText(profile.battery),'设备未上报时不估算电量')}}
    GridCol(){this.card('系统热等级',this.sampleText(profile.temperature)==='UNKNOWN'?'未提供':this.sampleText(profile.temperature),'系统热状态，不等于 CPU / GPU 温度；Windows 通常不提供此等级')}
   }
   ForEach(profile.pools,(pool:PoolV2)=>{
    Column({space:8}){
     Text(pool.kind==='RAM_BYTES'?'内存额度':pool.kind==='CPU_SLOTS'?'CPU 协同槽位':pool.kind==='GPU_SLOTS'?'GPU 协同槽位':pool.kind==='VRAM_BYTES'?'显存额度':pool.kind).fontSize(17).fontColor('#173252')
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
     Text('资格状态：'+this.qualificationText(profile.holderInstanceId,executor.target.targetId)).fontSize(13).fontColor('#9A650B')
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
     Row(){Text(item.title).fontSize(18).fontWeight(FontWeight.Medium).fontColor('#173252').layoutWeight(1);Text(this.taskState(item.state)).fontSize(14).fontColor('#9A650B').margin({left:12})}.width('100%')
     Text(item.detail).fontSize(13).fontColor('#64748B').width('100%')
     if(item.telemetry){
      GridRow({columns:this.wide?3:1,gutter:12}){
       GridCol(){this.card('整机 CPU 实测',this.metric(item.telemetry.sample.cpuPercent,'%'),'系统时间差采样；与 CPU 协同槽位不同')}
       GridCol(){this.card('整机内存使用',(item.telemetry.sample.memoryUsedBytes/1073741824).toFixed(1)+' GiB','总量 '+(item.telemetry.sample.memoryTotalBytes/1073741824).toFixed(1)+' GiB')}
       GridCol(){this.card('电池 / 供电',item.telemetry.sample.powerStatus==='NO_BATTERY'?'无电池':this.metric(item.telemetry.sample.batteryPercent,'%'),this.powerText(item.telemetry.sample.powerStatus))}
       if(item.telemetry.sample.gpuName){
        GridCol(){this.card('GPU 实测利用率',this.metric(item.telemetry.sample.gpuPercent,'%'),item.telemetry.sample.gpuName+' · NVIDIA 驱动采样')}
        GridCol(){this.card('GPU 温度',this.metric(item.telemetry.sample.gpuTemperatureC,'°C'),'显卡传感器；不代表整机热等级')}
       }
      }
      Text('硬件采样 '+new Date(item.telemetry.sample.sampledAt).toLocaleTimeString()+' · 短任务可能落在采样间隔内，请同时看下方执行回执。').fontSize(13).fontColor('#64748B')
     }else if(item.profiles){Text('设备未提供整机实时采样，以下为调度额度和执行回执；Windows 节点更新后显示 CPU、内存及可用硬件传感器。').fontSize(13).fontColor('#64748B')}
     if(item.profiles){
      Text('近期分配到本设备的任务 · '+this.recentWork(item.id).length).fontSize(19).fontWeight(FontWeight.Medium).fontColor('#173252')
      ForEach(this.recentWork(item.id),(task:CoordinatorOverviewRow)=>{
       Column({space:6}){Text(task.title+' · '+this.taskState(task.state)).fontSize(16).fontColor('#2459A5');Text(task.detail).fontSize(13).fontColor('#64748B');Text(task.id).fontSize(11).copyOption(CopyOptions.LocalDevice)}.alignItems(HorizontalAlign.Start).padding(12).width('100%').backgroundColor('#EEF4FC').borderRadius(10)
      },(task:CoordinatorOverviewRow)=>JSON.stringify(task))
     }
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
   Text(this.running?'本地服务已启动 · 实时设备与任务观测':'本地协调中心 · 服务尚未启动').fontSize(13).fontColor('#94600C').padding(14).width('100%').backgroundColor('#FFF5DD').borderRadius(10)
   if(this.selected===0){
    GridRow({columns:this.wide?3:1,gutter:14}){
     GridCol(){this.card('接入设备',String(this.snapshot.devices.length),'在线 '+this.onlineDevices().length+' · 按物理设备统计，与下方拓扑一致')}
     GridCol(){this.card('任务记录',String(this.snapshot.tasks.length),'最近 100 条执行记录')}
     GridCol(){this.card('在线宿主',String(this.snapshot.devices.reduce((count:number,row:CoordinatorOverviewRow)=>count+(row.profiles?.length??0),0)),'离线与后台宿主暂不展示')}
    }
    Column({space:14}){
     Text('设备协同拓扑 · '+this.onlineDevices().length+' 台在线设备').fontSize(20).fontWeight(FontWeight.Bold).fontColor('#173252')
     Text('鸿蒙协调中心 · '+this.address).fontSize(16).fontColor('#2459A5')
     if(!this.onlineDevices().length){Text('暂无在线设备；已接入但未就绪的设备可在“设备资源”中查看。').fontSize(14).fontColor('#64748B')}
     ForEach(this.onlineDevices(),(device:CoordinatorOverviewRow)=>{
      Column({space:6}){
       Text('↳ '+device.title+' · '+device.state).fontSize(17).fontColor('#173252')
       Text((device.profiles?.length??0)+' 个在线宿主 · '+(device.qualifications?.filter(q=>q.state==='ACTIVE').length??0)+' 项能力已就绪').fontSize(14).fontColor('#64748B')
       ForEach(device.profiles??[],(profile:DeviceProfileV2)=>{
        ForEach(profile.executors.filter(e=>e.target.backend!=='CPU'),(executor:ExecutorV2)=>{
         Text(executor.target.backend+' · '+executor.contract.capability+' · '+this.qualificationText(profile.holderInstanceId,executor.target.targetId)).fontSize(13).fontColor('#2459A5')
        },(executor:ExecutorV2)=>executor.target.targetId)
       },(profile:DeviceProfileV2)=>profile.holderInstanceId)
      }.alignItems(HorizontalAlign.Start).padding(14).width('100%').backgroundColor('#EEF4FC').borderRadius(12)
     },(device:CoordinatorOverviewRow)=>JSON.stringify(device))
    }.alignItems(HorizontalAlign.Start).padding(22).width('100%').backgroundColor('#FFFFFF').borderRadius(16)
    Text('最近执行').fontSize(20).fontWeight(FontWeight.Bold).fontColor('#173252').width('100%')
    this.rows({items:this.snapshot.tasks.slice(0,5),title:'暂无执行记录'})
   }else if(this.selected===1){
    this.empty('物理设备与应用宿主','已配对设备持续显示；连接、资源画像与计算资格分别判断，未就绪不代表尚未接入。')
    this.rows({items:this.snapshot.devices,title:'暂无在线前台设备'})
   }else if(this.selected===2){
    Text('应用观测显示 SoleAI 的完整业务阶段；计算任务显示真实派发目标与回执。云端商品查询不代表本地设备计算，GPU 也不一定参与轻量比价任务。').fontSize(15).fontColor('#64748B')
    this.rows({items:this.snapshot.tasks,title:'暂无任务追踪'})
   }
   else if(this.selected===3){
    this.empty('网络方向探测','显示在线设备上报的真实探测值；照片数据当前通过协调中心中转。')
    ForEach(this.snapshot.devices,(device:CoordinatorOverviewRow)=>{
     ForEach(device.profiles??[],(profile:DeviceProfileV2)=>{
      Column({space:12}){
       Text(device.title+' · '+profile.links.length+' 条方向记录').fontSize(19).fontColor('#173252')
       ForEach(profile.links,(link:LinkV2)=>{Text(link.from+' → '+link.to+'\n固定延迟 '+this.sampleText(link.fixedMs)+' · 传输速率 '+this.sampleText(link.bytesPerSecond)).fontSize(14).fontColor('#173252')},(link:LinkV2)=>link.from+':'+link.to+':'+link.networkEpoch)
      }.alignItems(HorizontalAlign.Start).padding(22).width('100%').backgroundColor('#FFFFFF').borderRadius(16)
     },(profile:DeviceProfileV2)=>JSON.stringify(profile))
    },(device:CoordinatorOverviewRow)=>JSON.stringify(device))
   }
   else if(this.selected===4){this.rows({items:this.snapshot.tasks.filter(item=>['FAILED','REJECTED','CANCEL_REQUESTED','YIELDED'].includes(item.state)),title:'暂无已记录异常'})}
   else if(this.selected===5){this.spaceControls();this.rows({items:this.snapshot.devices,title:'暂无在线前台设备'})}
   else if(this.selected===6){this.rows({items:this.snapshot.apps,title:'暂无应用授权'});this.empty('资源由协调中心分配','应用声明能力与工作流，CPU 和内存额度由设备状态与统一资源账本确定。')}
   else{
    Column({space:16}){
     Text('本机服务').fontSize(20).fontWeight(FontWeight.Bold).fontColor('#173252')
     Text(this.address?'自动识别的局域网地址：'+this.address:'启动时自动识别局域网地址').fontSize(15).fontColor('#173252')
     Text(this.status).fontSize(14).fontColor('#64748B').width('100%')
     if(this.fingerprint){Text('证书指纹').fontSize(13).fontColor('#64748B');Text(this.fingerprint).fontSize(12).fontColor('#173252').copyOption(CopyOptions.LocalDevice)}
    }.alignItems(HorizontalAlign.Start).padding(22).width('100%').backgroundColor('#FFFFFF').borderRadius(16)
   }
   if(this.detail){Column({space:12}){Text('记录详情').fontSize(20).fontWeight(FontWeight.Bold);Text(this.detail).fontSize(14).copyOption(CopyOptions.LocalDevice);Button('收起详情').onClick(()=>{this.detail='';})}.padding(20).width('100%').backgroundColor('#E3ECFA').borderRadius(16)}
  }.alignItems(HorizontalAlign.Start).padding(this.wide?32:18).width('100%')
 }
 @Builder
 launcher(){
  Column({space:24}){
   Row(){Column({space:8}){Text('智调鸿枢').fontSize(28).fontWeight(FontWeight.Bold).fontColor('#FFFFFF');Text('鸿蒙协调中心').fontSize(14).fontColor('#91A7C4')}.alignItems(HorizontalAlign.Start);Blank()}.width('100%')
   Blank()
   Button(this.busy?'…':'⏻',{type:ButtonType.Circle}).width(176).height(176).fontSize(74).fontColor(this.running?'#A9EED1':'#A8CEFF').backgroundColor(this.running?'#193C3D':'#142A48').border({width:2,color:this.running?'#52B995':'#35669F'}).enabled(!this.busy).onClick(()=>{if(this.running)void this.stop();else void this.start();})
   Text(this.busy?'正在准备…':this.running?'协调中心运行中':'启动协调中心').fontSize(26).fontWeight(FontWeight.Bold).fontColor('#FFFFFF')
   Text(this.running?'点击圆形按钮停止服务':'自动识别局域网，无需填写 IP 地址').fontSize(15).fontColor('#B9C9E0')
   Text(this.running?'https://'+this.address+':7443':this.status).fontSize(16).fontColor('#B9C9E0').textAlign(TextAlign.Center)
   Button('进入调度盘').width(260).height(52).backgroundColor('#2868C7').enabled(this.running&&!this.busy).onClick(()=>{this.home=false;this.selected=0;void this.refresh();})
   Button('图片任务演示').width(260).height(52).backgroundColor('#193C3D').enabled(this.running&&!this.busy).onClick(()=>{this.home=false;this.displayPage=true;})
   Blank()
   Text('设备与协调中心连接同一局域网后，通过二维码或配对码加入。').fontSize(14).fontColor('#91A7C4').textAlign(TextAlign.Center)
  }.padding(this.wide?40:24).width('100%').height('100%').backgroundColor('#0D1727')
 }
 build(){
  Column(){
   if(this.home){this.launcher()}else{
   Row(){Button('‹ 返回首页').fontSize(14).backgroundColor('#E3ECFA').fontColor('#2459A5').onClick(()=>{this.home=true;this.displayPage=false;});Button(this.displayPage?'返回调度盘':'图片任务演示').enabled(this.running).onClick(()=>{this.displayPage=!this.displayPage;});Blank();Text(this.running?'服务运行中':'服务已停止').fontSize(13).fontColor('#64748B')}.padding(12).width('100%')
   if(this.displayPage){Web({src:'http://127.0.0.1:7460/',controller:this.displayController}).javaScriptAccess(true).domStorageAccess(true).width('100%').layoutWeight(1)}else{
   Row(){
    if(this.wide){Column({space:10}){Text('智调鸿枢').fontSize(26).fontWeight(FontWeight.Bold).fontColor('#FFFFFF').margin({bottom:8});Text('调度观测 / OBSERVE').fontSize(12).fontColor('#91A7C4').margin({bottom:24});this.navigation();Blank();Text('多端资源 · 统一协调').fontSize(14).fontColor('#91A7C4')}.padding(22).width(232).height('100%').backgroundColor('#102139')}
    Scroll(){this.content()}.layoutWeight(1).height('100%').align(Alignment.Top)
   }.layoutWeight(1).width('100%')
   if(!this.wide){Scroll(){Row({space:8}){this.navigation()}.padding(10)}.scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).height(66).width('100%').backgroundColor('#102139')}
   }
   }
  }.width('100%').height('100%').backgroundColor('#F0F4FA').onAreaChange((oldArea:Area,newArea:Area)=>{this.wide=Number(newArea.width)>=900;})
 }
}
