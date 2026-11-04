import { displayAgent, leaveDisplay } from '../AgentRuntime';
interface DisplayView {id:string;sourceHolderId:string;state:string;version:number;shownVersion:number;text:string|null;}
@Entry
@Component
struct Display {
 @State invites:DisplayView[]=[];
 @State current:DisplayView|null=null;
 @State notice:string='';
 @State holder:string='';
 private timer:number=-1;
 private generation:number=0;
 private polling:boolean=false;
 private visible:boolean=false;
 onPageShow():void{
  this.visible=true;void this.refresh();this.timer=setInterval(()=>{void this.refresh();},750);
 }
 onPageHide():void{
  this.visible=false;clearInterval(this.timer);this.generation++;const old=this.current;
  this.current=null;this.invites=[];
  if(old)void leaveDisplay(old.id).catch(()=>{});
 }
 private async refresh():Promise<void>{
  if(this.polling||!this.visible)return;
  this.polling=true;const generation=this.generation;
  try{
   const host=displayAgent();this.holder=host.displayHolderId();
   const views=await host.displayInbox() as DisplayView[];
   if(generation!==this.generation||!this.visible)return;
   const id=this.current?.id;
   this.current=views.find((v:DisplayView)=>v.id===id&&v.state==='ACTIVE')??null;
   this.invites=views.filter((v:DisplayView)=>v.id!==this.current?.id);
   this.notice='';
  }catch(e){if(generation===this.generation){this.current=null;this.invites=[];this.notice=(e as Error).message;}}
  finally{this.polling=false;}
 }
 private async change(v:DisplayView,action:string):Promise<void>{
  const generation=++this.generation;
  try{
   const host=displayAgent();
   const next=await host.displaySession(v.id,action,{version:v.version}) as DisplayView;
   if(generation!==this.generation||!this.visible){
    if(!this.visible&&action==='accept'&&next.state==='ACTIVE')await host.displaySession(v.id,'leave');
    return;
   }
   this.current=next.state==='ACTIVE'?next:null;await this.refresh();
  }catch(e){if(generation===this.generation){this.notice=(e as Error).message;await this.refresh();}}
 }
 build(){
  Column({space:16}){
   Text('团队结果展示').fontSize(28).fontWeight(FontWeight.Bold)
   Text('本机展示 ID：'+this.holder).copyOption(CopyOptions.LocalDevice).fontSize(15)
   Text(this.notice).fontSize(14)
   if(this.current!==null){
    Text('来源 '+this.current.sourceHolderId+' · 版本 '+this.current.version).fontSize(15)
    Scroll(){Text(this.current.text??'等待来源设备发布结果').fontSize(22)}.layoutWeight(1)
    Button(this.current.shownVersion===this.current.version?'等待新版本':'确认已看到此版本').enabled(this.current.version>this.current.shownVersion).onClick(()=>{if(this.current)void this.change(this.current,'shown');})
    Button('退出展示').onClick(()=>{if(this.current)void this.change(this.current,'leave');})
   }else{
    Text(this.invites.length?'选择本机允许展示的会话':'等待同组设备邀请').fontSize(18)
    List(){ForEach(this.invites,(v:DisplayView)=>{ListItem(){Button('接收来自 '+v.sourceHolderId+' 的结果').onClick(()=>{void this.change(v,'accept');})}},(v:DisplayView)=>v.id)}.layoutWeight(1)
   }
  }.padding(24).width('100%').height('100%')
 }
}
