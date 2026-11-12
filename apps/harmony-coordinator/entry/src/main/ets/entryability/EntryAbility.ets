import { UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
export default class EntryAbility extends UIAbility {
 onCreate(want:Want):void{AppStorage.setOrCreate('coordinatorAddress',typeof want.parameters?.['address']==='string'?want.parameters['address'] as string:'');AppStorage.setOrCreate('coordinatorAutoStart',want.parameters?.['startService']===true);}
 onWindowStageCreate(stage:window.WindowStage):void {stage.loadContent('pages/Index');}
}
