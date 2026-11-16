import { agentWorkSlots } from '../AgentRuntime';

interface WorkSlot {
 id:string;workflowId:string;nodeId:string;capability:string;backend:string;sourceDeviceId:string;
 phase:string;state:string;step:number;elapsedMs:number;updatedAt:number;inputBytes:number|null;outputBytes:number|null;error:string;
}

@Component
export struct WorkSlotPanel {
 @State private active:WorkSlot[]=[];
 @State private history:WorkSlot[]=[];
 @State private observationError:boolean=false;
 private timer:number=-1;
 aboutToAppear():void{this.refresh();this.timer=setInterval(()=>this.refresh(),250);}
 aboutToDisappear():void{if(this.timer!==-1)clearInterval(this.timer);this.timer=-1;}
 private refresh():void {
  try{const rows=JSON.parse(agentWorkSlots()) as WorkSlot[];
   this.active=rows.filter(r=>r.state==='RUNNING');this.history=rows.filter(r=>r.state!=='RUNNING').sort((a:WorkSlot,b:WorkSlot)=>b.updatedAt-a.updatedAt).slice(0,5);this.observationError=false;
  }catch(e){this.observationError=true;}
 }
 private capability(row:WorkSlot):string {
  switch(row.capability){
   case 'catalog.filter.v1':
    if(this.isComparisonStage(row))return '候选商品比价数据整理';
    return '商品候选数据处理';
   case 'image.visual-match.v1':return '候选商品图像复核';
   case 'text.count.v1':return '文本统计';
   case 'image.crop.v1':return '图像裁剪';
   case 'vector.normalize.v1':return '向量归一化';
   case 'photo.analyze.v1':return '照片分析与校正';
   case 'photo.enhance.v1':return 'AI 照片高清增强';
   case 'photo.prepare.v1':return '照片图块准备';
   case 'photo.assemble.v1':return '照片合成与校验';
   case 'photo.deliver.v1':return '照片成品交付';
   default:return row.capability;
  }
 }
 private isComparisonStage(row:WorkSlot):boolean {
  return ['price-ranking','image-search-price-ranking','text-search-price-ranking'].includes(row.nodeId)||
   /-(image-search-|text-search-)?price-ranking-/.test(row.workflowId);
 }
 private workflow(row:WorkSlot):string {
  if(row.nodeId==='image-search-price-ranking'||row.workflowId.includes('-image-search-price-ranking-'))return '所属工作流：图片检索';
  if(row.nodeId==='text-search-price-ranking'||row.workflowId.includes('-text-search-price-ranking-'))return '所属工作流：文字检索';
  if(row.nodeId==='photo-candidates')return '所属工作流：图片检索';
  return '所属工作流：'+row.workflowId;
 }
 private workDescription(row:WorkSlot):string {
  if(row.capability==='catalog.filter.v1'&&this.isComparisonStage(row))return '实际工作：校验商品价格、换算价格单位，生成价格顺序索引。手机切换“价格从低到高”时使用；默认相关度列表不因此重排。';
  if(row.capability==='catalog.filter.v1')return '实际工作：按输入条件处理商品候选，返回价格与顺序数据。不代表已完成图像识别或结果页面重排。';
  if(row.capability==='image.visual-match.v1')return '实际工作：计算查询图片与候选商品图片的外观相似度，返回各图片对的分数。';
  if(row.capability==='image.crop.v1')return '实际工作：按照任务参数裁剪图片，返回处理后的图像。';
  if(row.capability==='text.count.v1')return '实际工作：统计输入文本，返回统计结果。';
  return '';
 }
 private phase(row:WorkSlot):string {
  if(row.state==='SUCCEEDED')return '本机完成 · 结果已发布';
  if(row.state==='REJECTED')return '未执行 · 准入拒绝';
  if(row.state==='FAILED')return '执行失败';
  if(row.state==='CANCELLED_SETTLED')return '已取消 · 资源已释放';
  if(row.state==='UNCONFIRMED')return '执行状态待核对';
  switch(row.phase){case 'RECEIVED':return '已收到任务';case 'QUEUE':return '排队与资源准入';case 'LOAD':return '读取任务输入';case 'EXECUTE':return '本机正在计算';case 'PUBLISH':return '发布计算结果';default:return row.phase;}
 }
 private byteText(value:number|null):string {return value===null?'待记录':value<1024?value+' B':value<1048576?(value/1024).toFixed(1)+' KiB':(value/1048576).toFixed(1)+' MiB';}
 @Builder
 private card(row:WorkSlot){
  Column({space:10}) {
   Text(this.workflow(row)).fontSize(13).fontColor('#A0ABC0').wordBreak(WordBreak.BREAK_ALL)
   Text('当前工作流阶段').fontSize(12).fontColor('#93C5FD')
   Row({space:12}){
    Text(this.capability(row)).fontSize(19).fontWeight(FontWeight.Bold).fontColor('#F1F5F9').layoutWeight(1)
    Text(row.backend).fontSize(13).fontColor('#93C5FD').padding(8).backgroundColor('#213558').borderRadius(8)
   }.width('100%')
   if(this.workDescription(row)){Text(this.workDescription(row)).fontSize(14).fontColor('#CBD5E1')}
   Text(this.phase(row)).fontSize(16).fontColor(row.state==='SUCCEEDED'?'#5EE2AE':row.state==='RUNNING'?'#93C5FD':'#FDBA74')
   Progress({value:row.step,total:5,type:ProgressType.Linear}).width('100%').color(row.state==='SUCCEEDED'?'#39C795':'#4D8CFF').backgroundColor('#303C51').style({strokeWidth:8})
   Text('接收 → 排队/准入 → 读取输入 → 计算 → 发布 → 完成').fontSize(12).fontColor('#A0ABC0')
   Text('能力 '+row.capability+' · 阶段 '+row.step+'/5 · '+(row.elapsedMs/1000).toFixed(3)+' 秒').fontSize(13).fontColor('#CBD5E1')
   Text('输入 '+this.byteText(row.inputBytes)+'   →   输出 '+this.byteText(row.outputBytes)).fontSize(14).fontColor('#CBD5E1')
   Text('工作流 '+row.workflowId+'\n步骤 '+row.nodeId+'\n任务 '+row.id).fontSize(11).fontColor('#94A3B8').wordBreak(WordBreak.BREAK_ALL)
   if(row.error){Text(row.error).fontSize(13).fontColor('#FDBA74')}
  }.alignItems(HorizontalAlign.Start).width('100%').padding(18).backgroundColor('#1B2434').borderRadius(16)
 }
 build(){
  Column({space:14}){
   Row(){Text('任务槽').fontSize(23).fontWeight(FontWeight.Bold).fontColor('#F1F5F9').layoutWeight(1)
    Text(this.active.length+' 项执行中').fontSize(14).fontColor('#93C5FD')
   }.width('100%')
   Text('实时观察分配到本机的工作流步骤').fontSize(14).fontColor('#A0ABC0')
   if(this.observationError){Text('任务观测暂不可用，等待恢复').fontColor('#FDBA74')}
   else if(this.active.length===0){
    Column({space:8}){
     Text('暂无任务').fontSize(24).fontWeight(FontWeight.Medium).fontColor('#CBD5E1')
     Text('收到任务后自动显示，无需手动刷新').fontSize(14).fontColor('#94A3B8')
    }.width('100%').padding(24).backgroundColor('#1B2434').borderRadius(16)
   }
   ForEach(this.active,(row:WorkSlot)=>{this.card(row)},(row:WorkSlot)=>row.id+'-'+row.phase+'-'+row.elapsedMs)
   if(this.history.length>0){
    Text('最近完成 / 异常 · 本次连接').fontSize(17).fontWeight(FontWeight.Medium).fontColor('#F1F5F9')
    ForEach(this.history,(row:WorkSlot)=>{this.card(row)},(row:WorkSlot)=>row.id+'-'+row.state)
   }
   Text('进度条表示实际执行阶段，不是时间百分比。短任务保留完成记录；校准不计入业务任务。完成表示本机发布结果，不代表整个工作流完成。').fontSize(12).fontColor('#94A3B8')
  }.width('100%').alignItems(HorizontalAlign.Start).padding(20).backgroundColor('#161B26').borderRadius(16)
 }
}
