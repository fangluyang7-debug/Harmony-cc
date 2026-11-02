import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { indexer } from '../IndexerSession';
export default class EntryAbility extends UIAbility {
 onCreate():void{indexer.initialize(this.context);}
 onForeground():void{indexer.lifecycle(true);}
 onBackground():void{indexer.lifecycle(false);}
 onDestroy():void{void indexer.close();}
 onWindowStageCreate(stage:window.WindowStage):void{stage.loadContent('pages/Index');}
}
