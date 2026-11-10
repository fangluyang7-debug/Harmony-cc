import {common} from '@kit.AbilityKit';
interface ReviewResultView {galleryId:string;summary:string;resultHash:string;}
@Entry
@Component
struct VisualReviewPage{
 @State query:string='500元以内的运动鞋';
 @State busy:boolean=false;
 @State result:string='';
 private async open():Promise<void>{this.busy=true;try{const context=this.getUIContext().getHostContext() as common.UIAbilityContext,result=await context.startAbilityForResult({bundleName:'org.harmonycc.agent',abilityName:'VisualReviewAbility',parameters:{query:this.query}});const raw=result.want?.parameters?.['reviewResult'];if(result.resultCode===0&&typeof raw==='string'){const view=JSON.parse(raw) as ReviewResultView;this.result=view.summary+'\n结果校验：'+view.resultHash;}else this.result='尚未返回完成结果；再次进入可恢复查看原记录。';}catch(e){this.result='无法打开图像计算页，请先安装新版 Harmony 协作空间并加入群组。\n'+(e as Error).message;}finally{this.busy=false;}}
 build(){Scroll(){Column({space:20}){
  Text('购物图像复核').fontSize(28).fontWeight(FontWeight.Bold)
  Text('真实商品检索 → 图像分片复核 → 相似商品线索。比较手机单机与手机＋电脑并行。').fontSize(16)
  TextInput({text:this.query,placeholder:'输入购物需求'}).enabled(!this.busy).onChange((v:string)=>{this.query=v;})
  Button('开始图像复核／查看上次记录').enabled(!this.busy).onClick(()=>{void this.open();})
  Text('将打开 Harmony 调度件的计算页，让手机保持前台参与计算。按页面的 1—4 步操作；完成后结果返回这里。请勿锁屏或切换应用，电脑可同时打开调度盘。').fontSize(14).fontColor('#52617A')
  if(this.result){Text(this.result).fontSize(16).width('100%')}
 }.padding(24).width('100%')}.height('100%')}
}
