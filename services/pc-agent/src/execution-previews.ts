import {fork,ChildProcess,ForkOptions} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {executionObserver} from './execution-observer';
type Item={id:string;input:Buffer;output:Buffer};
/** Optional, bounded, lower-priority presentation lane. Never awaited by execution. */
export class ExecutionPreviews {
 private until=0;private child:ChildProcess|null=null;private active:Item|null=null;private queue:Item[]=[];private pending=false;private timer:NodeJS.Timeout|null=null;
 constructor(private eligible:(id:string)=>boolean,private status:(id:string,value:any)=>void,private publish:(id:string,preview:any)=>void){}
 interest(){this.until=Date.now()+8000;this.schedule();}
 capture(id:string,input:Buffer,output:Buffer){
  if(Date.now()>this.until||!this.eligible(id))return;
  if(input.length+output.length>16*1048576){this.status(id,{state:'SKIPPED',reason:'图块过大，优先计算'});return;}
  while(this.queue.length>=4||this.queue.reduce((n,i)=>n+i.input.length+i.output.length,0)+input.length+output.length>32*1048576){const old=this.queue.shift();if(!old)break;this.status(old.id,{state:'SKIPPED',reason:'预览繁忙，计算正常完成'});}
  this.queue.push({id,input,output});this.status(id,{state:'PENDING'});this.schedule();
 }
 private schedule(){if(this.pending)return;this.pending=true;setImmediate(()=>{this.pending=false;try{this.pump();}catch{this.close();}});}
 private pump(){
  if(Date.now()>this.until){this.queue=[];if(!this.active)this.close();return;}
  if(!this.child){
   const options:ForkOptions&{windowsHide:boolean}={windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced',env:{...process.env,UV_THREADPOOL_SIZE:'1',VIPS_CONCURRENCY:'1'}};
   const child=fork(path.join(__dirname,'execution-preview-worker.js'),[],options);this.child=child;
   child.once('spawn',()=>{try{if(child.pid)os.setPriority(child.pid,os.constants.priority.PRIORITY_BELOW_NORMAL);}catch{}});
   child.on('message',(m:any)=>{const item=this.active;if(!item||m.id!==item.id)return;if(this.timer)clearTimeout(this.timer);this.timer=null;this.active=null;
    if(m.preview){this.publish(m.id,m.preview);const {input,output,...meta}=m.preview;this.status(m.id,{state:'READY',...meta});}else this.status(m.id,{state:'UNAVAILABLE'});this.schedule();});
   child.on('error',()=>this.failed(child));child.on('exit',()=>this.failed(child));
  }
  if(this.active||!this.queue.length)return;const item=this.queue.shift()!;this.active=item;
  this.timer=setTimeout(()=>this.failed(this.child!),8000);this.timer.unref();
  try{this.child.send(item,error=>{if(error&&this.active===item)this.failed(this.child!);});}catch{this.failed(this.child);}
 }
 private failed(child:ChildProcess|null){if(!child||child!==this.child)return;const item=this.active;this.close();if(item)this.status(item.id,{state:'UNAVAILABLE'});}
 close(){if(this.timer)clearTimeout(this.timer);this.timer=null;for(const item of [...this.queue,...(this.active?[this.active]:[])])this.status(item.id,{state:'SKIPPED',reason:'预览已暂停，计算不受影响'});this.queue=[];this.active=null;const child=this.child;this.child=null;try{child?.kill();}catch{}}
}
export const executionPreviews=new ExecutionPreviews(id=>executionObserver.has(id),(id,preview)=>executionObserver.update(id,{preview}), (id,preview)=>{
 if(process.connected)try{process.send?.({type:'execution-preview',id,preview},()=>{});}catch{}
});
