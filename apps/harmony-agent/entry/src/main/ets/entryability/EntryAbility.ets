import { UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Bootstrap, base64, text } from '../NativePlatform';
import { openAgent, foregroundAgent, closeAgent } from '../AgentRuntime';
export default class EntryAbility extends UIAbility {
 private mainWindow:window.Window|null=null;
 onCreate(want:Want):void {
  const encoded=want.parameters?.['bootstrap'];let bootstrap:Bootstrap|null=null;
  try{if(typeof encoded==='string')bootstrap=JSON.parse(text(base64.decodeSync(encoded))) as Bootstrap;}catch(e){AppStorage.setOrCreate('agentStatus','配对信息格式错误');return;}
  void openAgent(this.context,bootstrap).catch((e:Error)=>{const code=/^[A-Z_0-9:]+$/.test(e.message)?e.message:'AGENT_START_FAILED';AppStorage.setOrCreate('agentStatus',code);hilog.error(0x0001,'HarmonyAgent','%{public}s',code);});
 }
 onForeground():void {foregroundAgent(true);void this.mainWindow?.setWindowKeepScreenOn(true).catch(()=>{});}
 onBackground():void {foregroundAgent(false);void this.mainWindow?.setWindowKeepScreenOn(false).catch(()=>{});}
 onDestroy():void {void closeAgent();}
 onWindowStageCreate(stage:window.WindowStage):void {this.mainWindow=stage.getMainWindowSync();void this.mainWindow.setWindowKeepScreenOn(true).catch(()=>{});stage.loadContent('pages/ConnectionLauncher');}
}
