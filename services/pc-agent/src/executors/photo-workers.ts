import type {Socket} from 'node:net';
import {spawn,ChildProcessWithoutNullStreams} from 'node:child_process';

interface Worker {child:ChildProcessWithoutNullStreams;key:string;busy:boolean;idle?:ReturnType<typeof setTimeout>;}
const workers:Worker[]=[],wake=new Set<()=>void>();
function discard(w:Worker){if(w.idle)clearTimeout(w.idle);const i=workers.indexOf(w);if(i>=0)workers.splice(i,1);for(const fn of wake)fn();}
process.once('exit',()=>{for(const w of workers)w.child.kill();});

/** Bounded persistent CPU engines. Each command is still one newly supplied task.
 * Cancellation kills its worker and waits for exit before releasing the slot. */
export async function runPhotoWorker(executable:string,args:string[],signal?:AbortSignal,modelVersion=''):Promise<void>{
 const key=JSON.stringify([executable,args[0],args[1],args[4],args[5],modelVersion]);
 let worker:Worker|undefined;
 for(;;){
  if(signal?.aborted)throw Error('CANCELLED_SETTLED');
  worker=workers.find(w=>!w.busy&&w.key===key);
  if(worker)break;
  const unused=workers.find(w=>!w.busy);if(unused){unused.child.kill();discard(unused);}
  if(workers.length<4){const child=spawn(executable,['--server'],{windowsHide:true,stdio:'pipe'});worker={child,key,busy:false};workers.push(worker);child.once('close',()=>discard(worker!));break;}
  await new Promise<void>(resolve=>{const next=()=>{wake.delete(next);signal?.removeEventListener('abort',next);resolve();};wake.add(next);signal?.addEventListener('abort',next,{once:true});});
 }
 const w=worker;w.busy=true;if(w.idle)clearTimeout(w.idle);w.child.ref();for(const pipe of [w.child.stdin,w.child.stdout,w.child.stderr])(pipe as Socket).ref();
 try{
  await new Promise<void>((resolve,reject)=>{
   let stdout='',stderr='',finished=false,failure:Error|undefined;
   const cleanup=()=>{w.child.stdout.off('data',output);w.child.stderr.off('data',errors);w.child.off('error',error);w.child.stdin.off('error',error);w.child.off('close',closed);signal?.removeEventListener('abort',abort);};
   const end=(failure?:Error)=>{if(finished)return;finished=true;cleanup();failure?reject(failure):resolve();};
   const errors=(b:Buffer)=>{stderr=(stderr+b.toString()).slice(-4096);};
   const closed=()=>end(signal?.aborted?Error('CANCELLED_SETTLED'):failure??Error('PHOTO_WORKER_EXITED'));
   const error=()=>{failure=Error('PHOTO_WORKER_FAILED');w.child.kill();};
   const abort=()=>{w.child.kill();};
   const output=(b:Buffer)=>{stdout+=b.toString();if(!stdout.includes('\n'))return;const code=Number(stdout.trim().split('\t').pop());if(signal?.aborted){abort();return;}if(code!==0){end(Error(/PHOTO_[A-Z_]+/.exec(stderr)?.[0]??'PHOTO_INFERENCE_FAILED'));return;}end();};
   w.child.stdout.on('data',output);w.child.stderr.on('data',errors);w.child.once('close',closed);w.child.once('error',error);w.child.stdin.once('error',error);signal?.addEventListener('abort',abort,{once:true});
   w.child.stdin.write(args.map(a=>JSON.stringify(a)).join(' ')+'\n');if(signal?.aborted)abort();
  });
 }finally{
  w.busy=false;
  if(workers.includes(w)){w.idle=setTimeout(()=>{w.child.kill();},60000);w.idle.unref();w.child.unref();for(const pipe of [w.child.stdin,w.child.stdout,w.child.stderr])(pipe as Socket).unref();}
  for(const fn of wake)fn();
 }
}
