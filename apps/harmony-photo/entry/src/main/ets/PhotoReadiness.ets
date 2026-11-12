import { monotonic } from 'scheduler';

export interface ReadinessView { ready:boolean; message:string; elapsedMs:number; }
/** Observes qualification only; never reads selected photos or submits work. */
export class PhotoReadiness {
 private generation:number=0;
 private timer:number=-1;
 private ticker:number=-1;
 private began:number=0;
 private wasReady:boolean=false;
 private readyElapsed:number=0;
 private pending:()=>Promise<string[]>;
 private publish:(view:ReadinessView)=>void;
 private now:()=>number;
 private message:string='正在检查连接与图片处理能力…';
 constructor(pending:()=>Promise<string[]>,publish:(view:ReadinessView)=>void,now:()=>number=monotonic){this.pending=pending;this.publish=publish;this.now=now;}
 private send(view:ReadinessView):void{this.message=view.message;this.publish(view);}
 start():void{
  this.stop();const generation=this.generation;this.began=this.now();this.wasReady=false;this.readyElapsed=0;
  this.send({ready:false,message:'正在检查连接与图片处理能力…',elapsedMs:0});
  this.ticker=setInterval(()=>{if(generation===this.generation)this.publish({ready:this.wasReady,message:this.message,elapsedMs:this.wasReady?this.readyElapsed:Math.max(0,this.now()-this.began)});},1000);
  void this.poll(generation);
 }
 stop():void{this.generation++;if(this.timer!==-1){clearTimeout(this.timer);this.timer=-1;}if(this.ticker!==-1){clearInterval(this.ticker);this.ticker=-1;}}
 private async poll(generation:number):Promise<void>{
  try{
   const pending=await this.pending();if(generation!==this.generation)return;
   const ready=pending.length===0;
   if(this.wasReady&&!ready)this.began=this.now();
   if(ready&&!this.wasReady)this.readyElapsed=Math.max(0,this.now()-this.began);
   this.send({ready,message:ready?'已就绪 · 可以开始高清增强':'正在准备：'+pending.join('、'),elapsedMs:ready?this.readyElapsed:Math.max(0,this.now()-this.began)});
   this.wasReady=ready;
  }catch(e){
   if(generation!==this.generation)return;
   if(this.wasReady)this.began=this.now();this.wasReady=false;
   this.send({ready:false,message:'尚未就绪，正在重试：'+(e as Error).message,elapsedMs:Math.max(0,this.now()-this.began)});
  }
  if(generation===this.generation)this.timer=setTimeout(()=>{this.timer=-1;void this.poll(generation);},this.wasReady?3000:1000);
 }
}
