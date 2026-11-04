import { Candidate, searchSelectedImage } from '../services/V2ImageSearch';
import { indexer } from '../services/V2CropSession';

@Entry
@Component
struct V2ImageSearchPage {
  @State space:string='';
  @State busy:boolean=false;
  @State status:string='';
  @State candidates:Candidate[]=[];
  @State targetId:string='';
  @State invitation:string='';
  @State resultText:string='';

  private async search(useTarget:boolean):Promise<void> {
    if(this.busy)return;
    this.busy=true;this.candidates=[];this.resultText='';this.status='正在选择图片';
    try{
      const result=useTarget?await searchSelectedImage(this.space.trim(),{sdk:indexer.connectedSdk(),targetId:this.targetId.trim()}):
        await searchSelectedImage(this.space.trim());
      if(!result){this.status='已取消选图';return;}
      this.candidates=result.candidates;
      this.status=(result.encodingTargetId?'编码目标 '+result.encodingTargetId:'业务服务编码')+' · 索引 '+result.indexVersion+' · '+result.model.modelId+' · 服务端 '+result.processingMs.toFixed(1)+' ms · 共 '+result.candidates.length+' 项';
      this.resultText=this.status+'\n'+result.candidates.map((c:Candidate)=>c.productId+'  '+c.score.toFixed(4)).join('\n');
    }catch(e){this.status=(e as Error).message;}
    finally{this.busy=false;}
  }
  build(){
    Scroll(){Column({space:16}){
      Text('图像候选检索 · v2').fontSize(26).fontWeight(FontWeight.Bold)
      Text('使用当前业务服务编码并检索。选择一张图片，查看匹配商品和余弦相似度。').fontSize(16)
      TextInput({text:this.space,placeholder:'已启用的商品索引空间 ID'}).enabled(!this.busy).onChange((v:string)=>{this.space=v;})
      Button('选图并发送至业务服务').enabled(!this.busy&&this.space.trim().length>0).onClick(()=>{void this.search(false);})
      Text('使用团队设备编码').fontSize(18).fontWeight(FontWeight.Bold)
      TextInput({text:this.invitation,placeholder:'App 注册邀请，已注册可留空'}).onChange((v:string)=>{this.invitation=v;})
      Button('连接调度器').enabled(!this.busy).onClick(async()=>{
        this.busy=true;
        try{await indexer.connect(this.invitation);this.invitation='';this.status='已恢复 SDK 会话，等待执行目标就绪';}
        catch(e){this.status=(e as Error).message;}finally{this.busy=false;}
      })
      TextInput({text:this.targetId,placeholder:'可选：指定编码目标 ID，留空由调度器选择'}).onChange((v:string)=>{this.targetId=v;})
      Button(this.targetId.trim()?'在指定设备编码并检索':'自动选择团队设备并检索').enabled(!this.busy&&this.space.trim().length>0).onClick(()=>{void this.search(true);})
      Text(this.status).fontSize(15)
      Button('在团队设备展示结果').enabled(!this.busy&&this.resultText.length>0).onClick(()=>{
        AppStorage.setOrCreate('v2DisplayResult',this.resultText);
        this.getUIContext().getRouter().pushUrl({url:'pages/V2DisplaySharePage'});
      })
      ForEach(this.candidates,(c:Candidate)=>{
        Row(){Text(c.productId).layoutWeight(1);Text(c.score.toFixed(4))}.padding(12)
      },(c:Candidate)=>c.productId)
    }.padding(24).width('100%')}.height('100%')
  }
}
