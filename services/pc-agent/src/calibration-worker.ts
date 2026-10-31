import { EvaluationWork, validEvaluationWork } from '@harmony/resource-transport';
import { CalibrationExecutor } from './calibration-executor';
import { DurableLedger } from './durable-ledger';
import { ControlRequest } from './allotment-client';

export interface CalibrationWorkerOptions {
  domain:'REAL'|'SIMULATED';deviceInstanceId:string;
  ready():boolean;
  /** Check local owner/contribution policy and current coordinator epoch before starting an engine. */
  authorize(work:EvaluationWork):Promise<boolean>;
  onError(error:unknown):void;
}
/** One evaluation at a time; all result retries read the durable executor record, never invoke it again. */
export class CalibrationWorker {
  private stopped=false;private timer:NodeJS.Timeout|undefined;private pending:Promise<void>|undefined;
  private abort:AbortController|undefined;
  private started=false;private dirty=false;private retryMs=500;
  constructor(private readonly ledger:DurableLedger,private readonly executor:CalibrationExecutor,
    private readonly request:ControlRequest,private readonly options:CalibrationWorkerOptions){}
  tick():Promise<void>{
    if(this.stopped||!this.options.ready())return Promise.resolve();
    if(!this.pending)this.pending=this.step().finally(()=>{this.pending=undefined;});return this.pending;
  }
  private async step(){
    const reply=await this.request('/v2/evaluations/claim',{}) as {work:EvaluationWork|null};
    if(!reply||Object.keys(reply).join('|')!=='work')throw Error('EVALUATION_RESPONSE_INVALID');
    const work=reply.work;if(work===null)return;
    const state=this.ledger.snapshot();
    if(!validEvaluationWork(work)||work.permit.domain!==this.options.domain||work.permit.groupId!==state.groupId||
      work.permit.holderInstanceId!==state.holderInstanceId||work.executor.target.deviceId!==state.deviceId)throw Error('EVALUATION_SCOPE');
    let result=await this.executor.reconcile(work.permit);
    if(!result&&work.mode==='RUN'&&!this.ledger.status(work.permit.id)){
      const abort=new AbortController();this.abort=abort;
      let timer:NodeJS.Timeout|undefined,checking:Promise<void>|undefined;
      const check=async()=>{
        if(!this.options.ready()||!await this.options.authorize(work)){abort.abort();return;}
        const status=await this.request('/v2/evaluations/'+work.permit.id,null) as {cancel:boolean;settled:boolean};
        if(!status||typeof status.cancel!=='boolean'||typeof status.settled!=='boolean')throw Error('EVALUATION_STATUS_INVALID');
        if(status.cancel||status.settled)abort.abort();
      };
      const remaining=work.expiresAt-Date.now();
      const deadline=setTimeout(()=>abort.abort(),Math.max(1,Math.min(remaining,work.permit.timeoutMs)));
      try{
        if(work.ledgerEpoch!==state.ledgerEpoch||work.deviceInstanceId!==this.options.deviceInstanceId)return;
        if(this.stopped||remaining<=0)abort.abort();
        if(!abort.signal.aborted)await check();
        if(abort.signal.aborted)result=await this.executor.decline(work.permit);
        else{timer=setInterval(()=>{
          if(checking)return;
          checking=check().catch(error=>{abort.abort();this.options.onError(error);}).finally(()=>{checking=undefined;});
        },250);timer.unref();
        // Inputs, configs and parameters come only from the installed local pack.
        result=await this.executor.runInstalled(work.permit,work.executor,abort.signal);
        }
      }catch(error){
        // Only a received RUN with no durable admission may be declined. Unknown admitted work is never released.
        if(!this.ledger.status(work.permit.id))result=await this.executor.decline(work.permit);
        else throw error;
      }finally{clearTimeout(deadline);if(timer)clearInterval(timer);await checking;this.abort=undefined;}
    }
    if(result){
      const response=await this.request('/v2/evaluations/'+work.permit.id+'/report',{...result,output:result.output.toString('base64')}) as {acknowledged:boolean};
      if(response?.acknowledged!==true)throw Error('EVALUATION_ACK_INVALID');
    }
    // RECONCILE + no record is delivery uncertainty, never proof of settlement or permission to run.
  }
  /** Wake only on connection recovery, new durable work, or a retry of failed delivery. No idle polling. */
  notify(){
    if(!this.started||this.stopped)return;
    this.dirty=true;if(this.pending||this.timer)return;
    this.dirty=false;
    void this.tick().then(()=>{if(this.dirty)this.notify();},error=>{
      this.options.onError(error);
      if(!this.stopped){this.timer=setTimeout(()=>{this.timer=undefined;this.notify();},this.retryMs);this.timer.unref();}
    });
  }
  start(retryMs=500){
    if(this.stopped||this.started||!Number.isSafeInteger(retryMs)||retryMs<100)throw Error('CALIBRATION_WORKER_START');
    this.started=true;this.retryMs=retryMs;this.notify();
  }
  async close(){this.stopped=true;if(this.timer)clearTimeout(this.timer);this.abort?.abort();await this.pending?.catch(()=>{});}
}
