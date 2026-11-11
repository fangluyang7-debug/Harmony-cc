import { Candidate, searchSelectedImage } from '../services/V2ImageSearch';
import { cooperative } from '../services/CooperativeSession';

@Entry
@Component
struct V2ImageSearchPage {
  @State space:string='';
  @State busy:boolean=false;
  @State status:string='';
  @State candidates:Candidate[]=[];
  @StorageLink('cooperativeEnabled') cooperativeEnabled:boolean=false;
  @StorageLink('cooperativeChanging') cooperativeChanging:boolean=false;
  @StorageLink('cooperativeStatus') cooperativeStatus:string='尚未启用协同调度';
  @State resultText:string='';

  private async search():Promise<void> {
    if(this.busy)return;
    this.busy=true;this.candidates=[];this.resultText='';this.status='正在选择图片';
    try{
      const sdk=await cooperative.availableClient();
      const result=sdk?await searchSelectedImage(this.space.trim(),{sdk}):
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
      Row(){Text('协同调度（自动接入，可暂停）').layoutWeight(1);Toggle({type:ToggleType.Switch,isOn:this.cooperativeEnabled}).enabled(!this.busy&&!this.cooperativeChanging).onChange((value:boolean)=>{void cooperative.setEnabled(value).catch((e:Error)=>{this.status=e.message;});})}
      Text(this.cooperativeStatus).fontSize(14)
      Button('选择图片并检索').enabled(!this.busy&&!this.cooperativeChanging&&this.space.trim().length>0).onClick(()=>{void this.search();})
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
