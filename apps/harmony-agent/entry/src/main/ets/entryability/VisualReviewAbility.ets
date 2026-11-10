import {UIAbility,Want} from '@kit.AbilityKit';
import {window} from '@kit.ArkUI';
import {foregroundReview} from '../AgentRuntime';
export default class VisualReviewAbility extends UIAbility{
 private main:window.Window|null=null;
 onCreate(want:Want):void{const query=want.parameters?.['query'];AppStorage.setOrCreate('visualReviewQuery',typeof query==='string'?query.slice(0,200):'500元以内的运动鞋');}
 onForeground():void{foregroundReview(true);void this.main?.setWindowKeepScreenOn(true).catch(()=>{});}
 onBackground():void{foregroundReview(false);void this.main?.setWindowKeepScreenOn(false).catch(()=>{});}
 onDestroy():void{foregroundReview(false);}
 onWindowStageCreate(stage:window.WindowStage):void{this.main=stage.getMainWindowSync();void this.main.setWindowKeepScreenOn(true).catch(()=>{});stage.loadContent('pages/VisualReview');}
}
