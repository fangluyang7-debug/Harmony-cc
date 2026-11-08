import { UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { foregroundAgent } from '../AgentRuntime';
export default class EnrollmentAbility extends UIAbility {
 onCreate(want:Want):void {
  const raw=want.parameters?.['declaration'];
  AppStorage.setOrCreate('enrollmentRequest',typeof raw==='string'&&raw.length<=16384?raw:'');
 }
 onForeground():void{foregroundAgent(true);}
 onBackground():void{foregroundAgent(false);}
 onWindowStageCreate(stage:window.WindowStage):void{stage.loadContent('pages/Enrollment');}
}
