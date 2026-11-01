import { ControlRequest } from './allotment-client';
/** Retry only explicit pre-registration planner refusals, never ambiguous delivery. */
export async function submitWhenAvailable(request:ControlRequest,metadata:unknown,waiting:()=>void,
  options={timeoutMs:15000,delayMs:500}){
  const deadline=Date.now()+options.timeoutMs;let notified=false;
  for(;;){
    try{return await request('/v2/jobs',metadata);}
    catch(error){
      if(!(error instanceof Error)||!['CONTROL_REQUEST_REJECTED:NO_AVAILABLE_TARGET','CONTROL_REQUEST_REJECTED:NO_LEGAL_PLAN','CONTROL_REQUEST_REJECTED:ALLOTMENT_UNAVAILABLE'].includes(error.message))throw error;
      if(Date.now()>=deadline)throw Error('NO_AVAILABLE_TARGET');
      if(!notified){waiting();notified=true;}
      await new Promise(resolve=>setTimeout(resolve,Math.min(options.delayMs,Math.max(0,deadline-Date.now()))));
    }
  }
}
