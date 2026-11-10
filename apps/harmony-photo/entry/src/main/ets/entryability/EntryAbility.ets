import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { photoSession } from '../PhotoSession';
export default class EntryAbility extends UIAbility {
 private main:window.Window|null=null;
 onCreate():void{photoSession.initialize(this.context);}
 onForeground():void{photoSession.lifecycle(true);void this.main?.setWindowKeepScreenOn(true).catch(()=>{});}
 onBackground():void{photoSession.lifecycle(false);void this.main?.setWindowKeepScreenOn(false).catch(()=>{});}
 onDestroy():void{void photoSession.close();}
 onWindowStageCreate(stage:window.WindowStage):void{this.main=stage.getMainWindowSync();void this.main.setWindowKeepScreenOn(true).catch(()=>{});stage.loadContent('pages/Index');}
}
