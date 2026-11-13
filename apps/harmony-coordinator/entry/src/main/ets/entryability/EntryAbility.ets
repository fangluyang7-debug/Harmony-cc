import { UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
export default class EntryAbility extends UIAbility {
 private mainWindow:window.Window|null=null;
 onCreate(want:Want):void{AppStorage.setOrCreate('coordinatorAddress',typeof want.parameters?.['address']==='string'?want.parameters['address'] as string:'');AppStorage.setOrCreate('coordinatorAutoStart',want.parameters?.['startService']===true);}
 onForeground():void {void this.mainWindow?.setWindowKeepScreenOn(true).catch(()=>{});}
 onBackground():void {void this.mainWindow?.setWindowKeepScreenOn(false).catch(()=>{});}
 onWindowStageCreate(stage:window.WindowStage):void {this.mainWindow=stage.getMainWindowSync();void this.mainWindow.setWindowKeepScreenOn(true).catch(()=>{});stage.loadContent('pages/Index');}
}
