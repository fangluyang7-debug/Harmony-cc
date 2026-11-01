import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { fileIo } from '@kit.CoreFileKit';
import { HarmonySdkPort, SchedulerSdk, SdkWorkflow, SubmitOptions, TrustedCoordinator, text, bytes } from 'scheduler';
interface Invitation extends TrustedCoordinator {registrationId:string;code:string;}
interface ResultEvidence {jobId:string;state:string;deviceId:string;output:string;}
interface Evidence {status:string;path:string;results:ResultEvidence[];error:string|null;}
function save(path:string,value:string):void{const file=fileIo.openSync(path,fileIo.OpenMode.CREATE|fileIo.OpenMode.WRITE_ONLY|fileIo.OpenMode.TRUNC);try{fileIo.writeSync(file.fd,value);}finally{fileIo.closeSync(file);}}
/** Optional independent App exercise; without an invitation the S2 ledger probe stays unchanged. */
export async function runSdkProbe(context:common.UIAbilityContext,encoded:string|null=null):Promise<string|null>{
 if(encoded===null)return null;
 const evidence:Evidence={status:'RUNNING',path:'ARKTS_SDK_TO_PLANNING_SERVICE',results:[],error:null};
 try{
  const invitation=JSON.parse(text(new util.Base64Helper().decodeSync(encoded))) as Invitation,port=await HarmonySdkPort.open(context,invitation);
  await port.exchange(invitation.registrationId,invitation.code);const sdk=new SchedulerSdk(port);
  for(let i=0;i<2;i++){
   const capability=i===0?'text.count.v1':'vector.normalize.v1',payload=i===0?'{"text":"Hello Harmony"}':'{"dimension":2,"rows":[[3,4]]}',id=util.generateRandomUUID(true);
   const input=await sdk.registerInput(bytes(payload),i===0?'text.input':'vector.input');
   const workflow:SdkWorkflow={version:3,id,outputContract:i===0?'text.counts':'vector.normalized',qualityTarget:'reference',nodes:[{id:'compute',capability,input,parameters:'{}',dependsOn:[]}]},options:SubmitOptions={requestId:id,budgetMs:30000,resultDestination:'ORIGIN'};
   const task=await sdk.submit(workflow,options),result=await task.result(),output=text(result.output);
   const expected=i===0?'{"characters":13,"words":2,"lines":1}':'{"dimension":2,"rows":[[0.6,0.8]],"norms":[5]}';
   if(output!==expected)throw Error('SDK_RESULT_MISMATCH');
   evidence.results.push({jobId:id,state:result.status.state,deviceId:result.status.deviceId,output});sdk.releaseInput(input);
  }
  evidence.status='PASS';return 'PASS native ArkTS SDK submissions=2; text/vector outputs verified; run='+invitation.registrationId;
 }catch(error){evidence.status='FAIL';evidence.error=(error as Error).message;throw error as Error;}
 finally{save(context.filesDir+'/sdk-result.json',JSON.stringify(evidence));}
}
