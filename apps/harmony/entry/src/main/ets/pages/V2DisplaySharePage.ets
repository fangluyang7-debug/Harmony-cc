import {indexer} from '../services/V2CropSession';
interface View {id:string;version:number;shownVersion:number;state:string;}
@Entry
@Component
struct V2DisplaySharePage {
 @StorageLink('v2DisplayResult') result:string='';
 @State viewer:string='';
 @State notice:string='';
 @State active:boolean=false;
 @State busy:boolean=false;
 private session:string='';
 private timer:number=-1;
 private generation:number=0;
 private async update(action:string):Promise<void>{
  if(this.busy)return;
  this.busy=true;
  const generation=this.generation;
  try{
   const host=indexer.displayHost();
   let view:View;
   if(action==='invite'){
    view=await host.displayInvite(this.viewer.trim()) as View;
    if(generation!==this.generation){await host.displaySession(view.id,'revoke');return;}
    this.session=view.id;
   }else{
    view=await host.displaySession(this.session) as View;
    if(generation!==this.generation)return;
    if(action==='publish')view=await host.displaySession(this.session,'publish',{version:view.version+1,text:this.result}) as View;
    if(action==='revoke')view=await host.displaySession(this.session,'revoke') as View;
   }
   if(generation!==this.generation)return;
   this.active=view.state==='ACTIVE';
   this.notice=view.state==='INVITED'?'等待展示端同意':this.active?(view.version===0?'对方已同意，可以发布':view.shownVersion===view.version?'对方已确认看到第 '+view.version+' 版':'第 '+view.version+' 版已发布，等待对方确认'):'展示已结束';
   if(!this.active&&view.state!=='INVITED')this.session='';
  }catch(e){this.notice=(e as Error).message;}finally{this.busy=false;}
 }
 onPageShow():void{this.timer=setInterval(()=>{if(this.session)void this.update('status');},1000);}
 onPageHide():void{
  this.generation++;clearInterval(this.timer);const id=this.session;this.session='';this.active=false;
  if(id){try{void indexer.displayHost().displaySession(id,'revoke').catch(()=>{});}catch{}}
 }
 build(){
  Column({space:16}){
   Text('分享本次检索结果').fontSize(26)
   Text('接收端打开「结果展示」，同意后即可发布。').fontSize(16)
   TextInput({text:this.viewer,placeholder:'接收设备的 holder ID'}).onChange((v:string)=>{this.viewer=v;})
   Button('邀请展示端').enabled(!this.busy&&this.viewer.trim().length>0).onClick(()=>{if(!this.session)void this.update('invite');})
   Text(this.notice)
   Scroll(){Text(this.result).fontSize(18)}.layoutWeight(1)
   Button('发布此结果').enabled(this.active&&!this.busy).onClick(()=>{void this.update('publish');})
   Button('撤销展示').enabled(!this.busy).onClick(()=>{if(this.session)void this.update('revoke');})
  }.width('100%').height('100%').padding(24)
 }
}
