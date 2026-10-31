import { ControlRequest } from './allotment-client';
/** Only NO_AVAILABLE_TARGET proves no task was registered. Never retry ambiguous delivery. */
export async function submitWhenAvailable(request:ControlRequest,metadata:unknown,waiting:()=>void,
  options={timeoutMs:15000,delayMs:500}){
  const deadline=Date.now()+options.timeoutMs;let notified=false;
  for(;;){
    try{return await request('/v2/jobs',metadata);}
    catch(error){
      if(!(error instanceof Error)||error.message!=='CONTROL_REQUEST_REJECTED:NO_AVAILABLE_TARGET')throw error;
      if(Date.now()>=deadline)throw Error('NO_AVAILABLE_TARGET');
      if(!notified){waiting();notified=true;}
      await new Promise(resolve=>setTimeout(resolve,Math.min(options.delayMs,Math.max(0,deadline-Date.now()))));
    }
  }
}
