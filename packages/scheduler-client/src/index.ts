/** Public submission data contains no identity claims. Credentials bind the App on the server. */
export interface SdkInput {contentHash:string;bytes:number;schemaId:string;schemaVersion:number;}
export interface SdkNode {id:string;capability:string;input?:SdkInput;inputFrom?:string;parameters:string;dependsOn:string[];targetId?:string;}
export interface SdkWorkflow {version:3;id:string;outputContract:string;qualityTarget:string;nodes:SdkNode[];}
export interface SdkAlternatives {version:3;id:string;outputContract:string;qualityTarget:string;alternatives:SdkWorkflow[];}
export interface SubmitOptions {requestId:string;budgetMs:number;resultDestination:'ORIGIN';inputLocation?:'ORIGIN';}
export interface SdkSubmission {workflow:SdkWorkflow|SdkAlternatives;options:SubmitOptions;}
export interface SdkConfiguration {capacityWaitMs:number;}
export interface SdkRef {artifactId:string;contentVersion:number;contentHash:string;schemaId:string;schemaVersion:number;}
export interface SdkDirectRoute {jobId:string;endpointId:string;}
export interface SdkTicket {direct?:SdkDirectRoute;token:string;ref:SdkRef;bytes:number;expiresAt:number;operation:string;}
export interface SdkPlan {jobId:string;targetId:string;deviceId:string;reason:string;inputTicket:SdkTicket;inputDelivery?:'LOCAL'|'RELAY'|'DIRECT';inputEndpointId?:string;inputTickets?:SdkTicket[];}
export interface SdkInputTransfer {read:SdkTicket;write:SdkTicket;}
export interface SdkStatus {inputTransfers?:SdkInputTransfer[];jobId:string;state:string;targetId:string;deviceId:string;traceId:string;outputTicket:SdkTicket|null;}
export interface SdkResult {jobId:string;output:Uint8Array;status:SdkStatus;}
/** Platform adapter owns trust, authenticated requests, bytes and the clock. No agent dependency. */
export interface SdkPort {
 connected?():boolean;
 writeDirect?(jobId:string,endpointId:string,ticket:SdkTicket,bytes:Uint8Array):Promise<void>;
 stageInput?(input:SdkInput,bytes:Uint8Array):Promise<void>;
 cancelled?():boolean;
 request(route:string,body:string|null):Promise<string>;
 write(ticket:SdkTicket,bytes:Uint8Array):Promise<void>;
 read(ticket:SdkTicket):Promise<Uint8Array>;
 digest(bytes:Uint8Array):Promise<string>;
 now():number;
 wait(ms:number):Promise<void>;
}
export class SdkTask {
 private waiting:Promise<SdkResult>|undefined;
 readonly id:string;
 private readonly port:SdkPort;
 constructor(id:string,port:SdkPort){this.id=id;this.port=port;}
 async status():Promise<SdkStatus>{const status=JSON.parse(await this.port.request('/v2/sdk/jobs/'+this.id,null)) as SdkStatus;if(status.jobId!==this.id||typeof status.state!=='string')throw Error('SDK_RESPONSE_INVALID');return status;}
 async cancel():Promise<string>{return this.port.request('/v2/sdk/jobs/'+this.id+'/cancel','{}');}
 result(timeoutMs=60000):Promise<SdkResult>{
  if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>300000)return Promise.reject(Error('SDK_WAIT_INVALID'));
  if(!this.waiting)this.waiting=this.poll(timeoutMs).finally(()=>{this.waiting=undefined;});return this.waiting;
 }
 private async poll(timeoutMs:number):Promise<SdkResult>{
  const deadline=this.port.now()+timeoutMs;
  while(this.port.now()<deadline){
   const status=await this.status();
   for(const transfer of status.inputTransfers??[]){const bytes=await this.port.read(transfer.read);if(bytes.byteLength!==transfer.write.bytes||await this.port.digest(bytes)!==transfer.write.ref.contentHash)throw Error('SDK_TRANSFER_INTEGRITY');await this.port.write(transfer.write,bytes);}
   if(status.outputTicket){const output=await this.port.read(status.outputTicket);if(output.byteLength!==status.outputTicket.bytes||await this.port.digest(output)!==status.outputTicket.ref.contentHash)throw Error('SDK_OUTPUT_INTEGRITY');return {jobId:this.id,output,status};}
   if(['FAILED','REJECTED','CANCELLED','CANCELLED_SETTLED','SIDE_EFFECT_UNKNOWN','HOLDER_RECORD_MISSING','BUDGET_EXHAUSTED'].includes(status.state))throw Error('JOB_'+status.state);
   await this.port.wait(250);
  }
  // A wait timeout never cancels work, releases capacity, or resubmits an attempt.
  throw Error('SDK_RESULT_WAIT_TIMEOUT');
 }
 onResult(success:(result:SdkResult)=>void,failure:(error:Error)=>void):void{void this.result().then(success,failure);}
}
function isAlternatives(value:SdkWorkflow|SdkAlternatives):boolean{
 return (value as SdkAlternatives).alternatives!==undefined;
}
export class SchedulerSdk {
 private readonly inputs=new Map<string,Uint8Array>();
 private readonly port:SdkPort;
 private readonly capacityWaitMs:number;
 constructor(port:SdkPort,configuration?:SdkConfiguration){this.port=port;this.capacityWaitMs=configuration?.capacityWaitMs??15000;if(!Number.isSafeInteger(this.capacityWaitMs)||this.capacityWaitMs<0||this.capacityWaitMs>15000)throw Error('SDK_WAIT_INVALID');}
 async registerInput(bytes:Uint8Array,schemaId:string,schemaVersion=1):Promise<SdkInput>{
  if(bytes.byteLength<1||bytes.byteLength>8388608||!schemaId||schemaVersion!==1)throw Error('SDK_INPUT_INVALID');
  const copy=new Uint8Array(bytes),contentHash=await this.port.digest(copy);if(!/^[a-f0-9]{64}$/.test(contentHash))throw Error('SDK_HASH_INVALID');
  this.inputs.set(contentHash,copy);return {contentHash,bytes:copy.byteLength,schemaId,schemaVersion};
 }
 releaseInput(input:SdkInput):void{this.inputs.delete(input.contentHash);}
 resume(jobId:string):SdkTask{if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(jobId))throw Error('SDK_JOB_ID_INVALID');return new SdkTask(jobId,this.port);}
 async plan(workflow:SdkWorkflow|SdkAlternatives,options:SubmitOptions):Promise<SdkPlan>{
  const deadline=this.port.now()+this.capacityWaitMs,body=JSON.stringify({workflow,options});
  for(;;){
   if(this.port.connected?.()===false)throw Error('SDK_COORDINATOR_OFFLINE');
   if(this.port.cancelled?.())throw Error('SDK_SUBMISSION_CANCELLED');
   try{const plan=JSON.parse(await this.port.request('/v2/sdk/jobs',body)) as SdkPlan;
    if(plan.jobId!==options.requestId||!plan.inputTicket||plan.inputTicket.operation!=='WRITE')throw Error('SDK_RESPONSE_INVALID');return plan;
   }catch(error){
    // Only explicit pre-registration refusals are retried. An ambiguous delivery is never replayed.
    const code=(error as Error).message;if(!['NO_LEGAL_PLAN','ALLOTMENT_UNAVAILABLE','PLAN_STALE'].includes(code)||this.port.now()>=deadline)throw error as Error;
    await this.port.wait(500);
   }
  }
 }
 private async startJob(jobId:string,deadline:number):Promise<void>{
  for(;;){
   if(this.port.cancelled?.())throw Error('SDK_SUBMISSION_CANCELLED');
   try{await this.port.request('/v2/sdk/jobs/'+jobId+'/start','{}');return;}
   catch(error){
    const code=(error as Error).message;
    if(!['ALLOTMENT_UNAVAILABLE','ALLOTMENT_ACK_PENDING','PLAN_STALE','START_BUSY','SDK_REQUEST_TIMEOUT'].includes(code)||this.port.now()>=deadline)throw error as Error;
    await this.port.wait(Math.min(250,Math.max(0,deadline-this.port.now())));
   }
  }
 }
 async submit(workflow:SdkWorkflow|SdkAlternatives,options:SubmitOptions):Promise<SdkTask>{
  // Hold registered snapshots across asynchronous planning, even if the caller releases them.
  const available=new Map<string,Uint8Array>();
  const paths:SdkWorkflow[]=isAlternatives(workflow)?(workflow as SdkAlternatives).alternatives:[workflow as SdkWorkflow];
  for(const path of paths)for(const node of path.nodes){
   if(node.inputFrom!==undefined)continue;
   const input=node.input;if(input===undefined)throw Error('SDK_INPUT_REQUIRED');const bytes=this.inputs.get(input.contentHash);
   if(!bytes||bytes.byteLength!==input.bytes)throw Error('SDK_INPUT_NOT_REGISTERED');
   available.set(input.contentHash,bytes);
  }
  // Plan/refuse using metadata before reading any input into the transport.
  if(options.inputLocation==='ORIGIN'){
   if(!this.port.stageInput)throw Error('SDK_LOCAL_HOST_REQUIRED');
   for(const path of paths)for(const node of path.nodes){if(node.input!==undefined)await this.port.stageInput(node.input,available.get(node.input.contentHash)!);}
  }
  const plan=await this.plan(workflow,options),bytes=available.get(plan.inputTicket.ref.contentHash);
  if(this.port.cancelled?.()){await this.resume(plan.jobId).cancel();throw Error('SDK_SUBMISSION_CANCELLED');}
  if(!bytes||bytes.byteLength!==plan.inputTicket.bytes)throw Error('SDK_INPUT_NOT_REGISTERED');
  if(plan.inputDelivery==='DIRECT'){
   if(!plan.inputEndpointId||!this.port.writeDirect)throw Error('SDK_DIRECT_PORT_REQUIRED');
   await this.port.writeDirect(plan.jobId,plan.inputEndpointId,plan.inputTicket,bytes);
  }else if(plan.inputDelivery!=='LOCAL')for(const ticket of plan.inputTickets??[plan.inputTicket]){const content=available.get(ticket.ref.contentHash);if(!content||content.byteLength!==ticket.bytes)throw Error('SDK_INPUT_NOT_REGISTERED');await this.port.write(ticket,content);}
  if(this.port.cancelled?.()){await this.resume(plan.jobId).cancel();throw Error('SDK_SUBMISSION_CANCELLED');}
  const startDeadline=this.port.now()+Math.min(this.capacityWaitMs,options.budgetMs??30000);
  try{await this.startJob(plan.jobId,startDeadline);}
  catch(error){
   // An explicit pre-dispatch replan may now require relay bytes; never retry ambiguous delivery.
   if(!['LOCAL','DIRECT'].includes(plan.inputDelivery??'')||(error as Error).message!=='INPUT_NOT_UPLOADED')throw error as Error;
   await this.port.write(plan.inputTicket,bytes);
   await this.startJob(plan.jobId,startDeadline);
  }
  return this.resume(plan.jobId);
 }
}
