/** Recover transport within the caller's deadline. Submission callers must only retry a known pre-send failure with the same request identity. */
export function transientPhotoTransport(error:Error):boolean{
 return /operation timeout|timed out|\bTIMEOUT\b|HTTP_(502|503|504)|SDK_COORDINATOR_OFFLINE|CONTROL_(DISCONNECTED|SEND_FAILED)|ECONNRESET|connection reset/i.test(error.message);
}
export async function recoverPhotoDelivery<T>(operation:(attempt:number)=>Promise<T>,remaining:()=>number,cancelled:()=>boolean,retrying:()=>void,retryable:(error:Error)=>boolean=transientPhotoTransport):Promise<T>{
 for(let attempt=0;;attempt++){
  if(cancelled())throw Error('已取消');if(remaining()<=0)throw Error('180 秒预算已用尽');
  try{return await operation(attempt);}catch(e){
   const error=e as Error;if(!retryable(error)||attempt>=2&&!/SDK_COORDINATOR_OFFLINE|CONTROL_(DISCONNECTED|SEND_FAILED)|ECONNRESET|connection reset/i.test(error.message))throw error;
   if(cancelled())throw Error('已取消');const delay=Math.min(1000,250*(attempt+1));if(remaining()<=delay)throw error;
   retrying();await new Promise<void>(resolve=>{setTimeout(resolve,delay);});
  }
 }
}
