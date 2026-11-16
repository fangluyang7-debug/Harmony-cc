/** Observation credentials only; this does not enroll a device or dispatch work. */
export async function photoDisplayConnection(publicUrl:string,port=Number(process.env.HARMONY_DISPLAY_PORT||7460)){
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('PHOTO_DISPLAY_UNAVAILABLE');
  const response=await fetch(`http://127.0.0.1:${port}/session`,{signal:AbortSignal.timeout(2000),redirect:'error'});
  if(!response.ok)throw Error('PHOTO_DISPLAY_UNAVAILABLE');
  const value=await response.json() as {displayOnly?:boolean;invitation?:string};
  if(value.displayOnly!==true||typeof value.invitation!=='string'||!/^http:\/\/\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}\/#display=[a-f0-9]{36}$/.test(value.invitation)||new URL(value.invitation).hostname!==new URL(publicUrl).hostname)throw Error('PHOTO_DISPLAY_UNAVAILABLE');
  return {displayOnly:true,invitation:value.invitation};
}
