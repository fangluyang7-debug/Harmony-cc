/** Retry result transport only. Never resubmit a workflow or recompute a tile. */
export function transientPhotoTransport(error:Error):boolean{
 return /operation timeout|timed out|\bTIMEOUT\b|HTTP_(502|503|504)/i.test(error.message);
}
export async function recoverPhotoDelivery<T>(operation:(attempt:number)=>Promise<T>,remaining:()=>number,cancelled:()=>boolean,retrying:()=>void,retryable:(error:Error)=>boolean=transientPhotoTransport):Promise<T>{
 for(let attempt=0;;attempt++){
  if(cancelled())throw Error('已取消');if(remaining()<=0)throw Error('180 秒预算已用尽');
  try{return await operation(attempt);}catch(e){
   const error=e as Error;if(attempt>=2||!retryable(error))throw error;
   if(cancelled())throw Error('已取消');const delay=250*(attempt+1);if(remaining()<=delay)throw error;
   retrying();await new Promise<void>(resolve=>{setTimeout(resolve,delay);});
  }
 }
}
