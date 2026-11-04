import { indexer, showError } from '../IndexerSession';
@Entry
@Component
struct Index {
 @State invitation:string='';
 @StorageLink('indexerStatus') status:string='';
 @StorageLink('indexerImages') images:string[]=[];
 @StorageLink('indexerBusy') busy:boolean=false;
 build(){
  Column({space:16}){
   Text('本地图片索引').fontSize(28).fontWeight(FontWeight.Bold)
   Text('选择最多 8 张图片，每张不超过 8 MiB。图片保存在本 App 私有目录。').fontSize(14)
   TextArea({text:this.invitation,placeholder:'粘贴 App 注册邀请；已注册可留空恢复'}).height(110).onChange((value:string)=>{this.invitation=value;})
   Button('连接 / 恢复').enabled(!this.busy).onClick(()=>{void indexer.connect(this.invitation).then(()=>{this.invitation='';}).catch(showError);})
   Row({space:12}){
    Button('选择图片并生成').enabled(!this.busy).onClick(()=>{void indexer.selectAndRun().catch(showError);})
    Button('取消当前任务').enabled(this.busy).onClick(()=>{void indexer.cancel().catch(showError);})
   }
   Text(this.status).fontSize(15)
   Row({space:12}){
    Button('选图加入索引').enabled(!this.busy).onClick(()=>{void indexer.encodeSelection(false).catch(showError);})
    Button('以图查询').enabled(!this.busy).onClick(()=>{void indexer.encodeSelection(true).catch(showError);})
   }
   Scroll(){Column({space:12}){ForEach(this.images,(uri:string)=>{Image(uri).width(128).height(128).objectFit(ImageFit.Contain)},(uri:string)=>uri)}}.layoutWeight(1)
  }.padding(24).width('100%').height('100%')
 }
}
