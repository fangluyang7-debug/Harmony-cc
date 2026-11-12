import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { util } from '@kit.ArkTS';
import { CoordinatorDatabase, CoordinatorOverview, CoordinatorOverviewRow, CoordinatorCertificate, createCoordinatorCertificate, CoordinatorTlsServer, CoordinatorDiscovery, CoordinatorPairing, CoordinatorRoutes, CoordinatorLocalAdmin, CoordinatorAllotments, CoordinatorGrantCrypto, CoordinatorCredentials, CoordinatorDeviceSettings } from 'scheduler';
@Entry
@Component
struct Index {
 @State wide:boolean=false;
 @State selected:number=0;
 @State detail:string='';
 @State snapshot:CoordinatorOverview={spaces:[],devices:[],tasks:[],apps:[]};
 private labels:string[]=['运行总览','设备资源','任务追踪','网络链路','异常恢复','设备接入','应用授权','中心设置'];
 private database:CoordinatorDatabase|null=null;
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
 private server:CoordinatorTlsServer=new CoordinatorTlsServer();
 private discovery:CoordinatorDiscovery=new CoordinatorDiscovery();
 aboutToAppear():void{void this.refresh();this.address=AppStorage.get<string>('coordinatorAddress')??'';if(AppStorage.get<boolean>('coordinatorAutoStart'))void this.start();}
 private async start():Promise<void>{
  if(this.busy||this.running)return;this.busy=true;
  try{
   const context=getContext(this) as common.UIAbilityContext;
   this.status='正在打开协调中心数据库';const db=this.database??await CoordinatorDatabase.open(context);this.database=db;this.snapshot=await db.overview();
   const storage=await preferences.getPreferences(context,{name:'coordinator-identity'});
   let id=await storage.get('id','') as string;if(!id){id=util.generateRandomUUID(true);await storage.put('id',id);await storage.flush();}
   this.status='正在生成设备证书';const raw=await storage.get('certificate','') as string,addresses=this.address.trim()?[this.address.trim()]:[];
   const identity:CoordinatorCertificate=raw?JSON.parse(raw) as CoordinatorCertificate:await createCoordinatorCertificate(addresses);
   if(!raw){await storage.put('certificate',JSON.stringify(identity));await storage.flush();}
   this.fingerprint=identity.fingerprint;const epoch=await db.startEpoch(id);
   const address='https://'+this.address.trim()+':7443';
   const pairing=new CoordinatorPairing(db,identity,'REAL'),routes=new CoordinatorRoutes(pairing,identity,address,epoch);
   const allotments=new CoordinatorAllotments(db,await CoordinatorGrantCrypto.create(identity.privateKey),epoch);routes.installAllotments(new CoordinatorCredentials(db,'REAL'),allotments);routes.installDeviceSettings(new CoordinatorDeviceSettings(db,allotments));
   this.admin=new CoordinatorLocalAdmin(db,pairing,'local-'+id,address);
   this.activeSpace=await this.admin.ensureDefaultSpace();this.snapshot=await db.overview();
   await this.server.start(identity,7443,request=>routes.handle(request));
   if(this.address.trim())await this.discovery.start('https://'+this.address.trim()+':7443');
   hilog.info(0x0001,'HarmonyCoordinator','TLS_LISTENING epoch=%{public}d fingerprint=%{public}s',epoch,identity.fingerprint);
   this.running=true;this.status='配对服务与数据库已启动 · epoch '+epoch+'\n任务调度协议仍在移植';
  }catch(e){await this.discovery.close().catch(()=>{});await this.server.close().catch(()=>{});this.status=(e as Error).message;hilog.error(0x0001,'HarmonyCoordinator','START_FAILED %{public}s',this.status);}finally{this.busy=false;}
 }
 private async refresh():Promise<void>{
  try{if(!this.database)this.database=await CoordinatorDatabase.open(getContext(this) as common.UIAbilityContext);this.snapshot=await this.database.overview();}catch(e){this.status=(e as Error).message;}
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
 @Builder
 rows(items:CoordinatorOverviewRow[],title:string){
  if(items.length===0){this.empty(title,'当前本地协调中心暂无记录。连接与调度服务接通后显示真实数据。')}
  else{
   ForEach(items,(item:CoordinatorOverviewRow)=>{
    Column({space:10}){
     Row(){Text(item.title).fontSize(18).fontWeight(FontWeight.Medium).fontColor('#173252').layoutWeight(1);Text(item.state).fontSize(12).fontColor('#9A650B').margin({left:12})}.width('100%')
     Text(item.detail).fontSize(13).fontColor('#64748B').width('100%')
     Text(item.id).fontSize(12).fontColor('#64748B').width('100%')
     Button('查看记录').fontSize(13).backgroundColor('#EAF1FB').fontColor('#2459A5').onClick(()=>{this.detail=item.title+'\n'+item.id+'\n'+item.detail+'\n状态：'+item.state;})
    }.alignItems(HorizontalAlign.Start).padding(20).width('100%').backgroundColor('#FFFFFF').borderRadius(16)
   },(item:CoordinatorOverviewRow)=>item.id)
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
     GridCol(){this.card('已登记设备',String(this.snapshot.devices.length),'不代表当前在线数量')}
     GridCol(){this.card('任务记录',String(this.snapshot.tasks.length),'最近 100 条执行记录')}
     GridCol(){this.card('协作空间',String(this.snapshot.spaces.length),'本地持久化空间')}
    }
    this.empty('设备协同拓扑','等待有效设备画像与控制链路；未知资源不计入可调度额度。')
    Text('最近执行').fontSize(20).fontWeight(FontWeight.Bold).fontColor('#173252').width('100%')
    this.rows(this.snapshot.tasks.slice(0,5),'暂无执行记录')
   }else if(this.selected===1){
    this.empty('物理设备与应用宿主','运行内存、实时可分配额度、任务占用分别展示。离线与后台暂停宿主在状态接通后默认折叠。')
    this.rows(this.snapshot.devices,'暂无设备')
   }else if(this.selected===2){this.rows(this.snapshot.tasks,'暂无任务追踪')}
   else if(this.selected===3){this.empty('网络与数据传输','方向探测、端点和传输回执尚未接入本地服务。暂无数据不表示设备之间已经可达。')}
   else if(this.selected===4){this.rows(this.snapshot.tasks.filter(item=>['FAILED','REJECTED','CANCEL_REQUESTED','YIELDED'].includes(item.state)),'暂无已记录异常')}
   else if(this.selected===5){this.spaceControls();this.rows(this.snapshot.devices,'暂无接入设备')}
   else if(this.selected===6){this.rows(this.snapshot.apps,'暂无应用授权');this.empty('资源由协调中心分配','应用声明能力与工作流，CPU 和内存额度由设备状态与统一资源账本确定。')}
   else{
    Column({space:16}){
     Text('本机服务').fontSize(20).fontWeight(FontWeight.Bold).fontColor('#173252')
     TextInput({text:this.address,placeholder:'局域网 IPv4 地址'}).enabled(!this.running&&!this.busy).onChange(v=>{this.address=v;})
     Button(this.busy?'正在启动…':'启动服务').enabled(!this.running&&!this.busy).width('100%').onClick(()=>{void this.start();})
     Button('停止服务').enabled(this.running).width('100%').onClick(()=>{void this.discovery.close().then(()=>this.server.close()).then(()=>{this.running=false;this.status='服务已停止';});})
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
