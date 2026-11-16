import { UIAbility, Want, AbilityConstant } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { photoSession } from '../PhotoSession';
export default class EntryAbility extends UIAbility {
 private main:window.Window|null=null;
 onCreate(_want:Want,launch:AbilityConstant.LaunchParam):void{hilog.info(0x0001,'HarmonyPhoto','APP_START lastExitReason=%{public}d lastExitMessage=%{public}s',launch.lastExitReason,launch.lastExitMessage??'');photoSession.initialize(this.context);}
 onForeground():void{photoSession.lifecycle(true);void this.main?.setWindowKeepScreenOn(true).catch(()=>{});}
 onBackground():void{photoSession.lifecycle(false);void this.main?.setWindowKeepScreenOn(false).catch(()=>{});}
 onDestroy():void{void photoSession.close().catch((e:Error)=>hilog.error(0x0001,'HarmonyPhoto','APP_CLOSE_FAILED %{public}s',e.message));}
 onWindowStageCreate(stage:window.WindowStage):void{this.main=stage.getMainWindowSync();void this.main.setWindowKeepScreenOn(true).catch(()=>{});stage.loadContent('pages/Index');}
}
