import { hidebug } from '@kit.PerformanceAnalysisKit';
interface TaskActivity {taskId:string;operation:string;phase:string;state:string;startedAt:number;updatedAt:number;error:string;}
interface Activity {sampledAt:number;processMemoryBytes:number|null;processCpuUsage:number|null;tasks:TaskActivity[];}
class ShoppingActivity {
 private tasks:TaskActivity[]=[];
 private sender:((body:string)=>Promise<void>)|null=null;
 private timer:number=-1;
 private busy:boolean=false;
 configure(sender:(body:string)=>Promise<void>):void{this.sender=sender;}
 foreground(value:boolean):void{if(this.timer>=0)clearInterval(this.timer);this.timer=-1;if(value){this.timer=setInterval(()=>{void this.publish();},2000);void this.publish();}}
 begin(taskId:string,operation:string):void{const now=Date.now();this.tasks.push({taskId,operation,phase:'PREPARING',state:'RUNNING',startedAt:now,updatedAt:now,error:''});this.tasks=this.tasks.slice(-20);void this.publish();}
 phase(id:string,phase:string):void{const task=this.tasks.find(t=>t.taskId===id);if(task){task.phase=phase;task.updatedAt=Date.now();void this.publish();}}
 finish(id:string,state:string,error:string):void{const task=this.tasks.find(t=>t.taskId===id);if(task){task.phase='FINISHED';task.state=state;task.error=error.slice(0,160);task.updatedAt=Date.now();void this.publish();}}
 private async publish():Promise<void>{
  if(this.busy||!this.sender)return;this.busy=true;
  try{let memory:number|null=null;try{memory=Number(hidebug.getPss())*1024;}catch(_){}
   let cpu:number|null=null;try{const measured=hidebug.getCpuUsage();if(Number.isFinite(measured)&&measured>=0)cpu=measured;}catch(_){}
   const activity:Activity={sampledAt:Date.now(),processMemoryBytes:memory,processCpuUsage:cpu,tasks:this.tasks};await this.sender(JSON.stringify(activity));
  }catch(_){}finally{this.busy=false;}
 }
}
export const shoppingActivity=new ShoppingActivity();
