import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { util } from '@kit.ArkTS';
import { relationalStore } from '@kit.ArkData';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { runLedgerFixtures, acceptedFixture } from '../LedgerFixtures';
import { AgentStoreV2, AgentPersistenceV2, AgentMessageFactoryV2, agentMessageV2, bindAgentJournalV2 } from 'scheduler';
interface Ack {messageId:string;}
export default class EntryAbility extends UIAbility {
  async onCreate():Promise<void> {
    try{
      const fixtures=util.TextDecoder.create('utf-8').decodeToString(await this.context.resourceManager.getRawFileContent('ledger-v2.json'));
      const count=runLedgerFixtures(fixtures);
      const db=await relationalStore.getRdbStore(this.context,{name:'probe.db',securityLevel:relationalStore.SecurityLevel.S1});
      await db.executeSql('CREATE TABLE IF NOT EXISTS proof (id INTEGER PRIMARY KEY, launches INTEGER NOT NULL, fixtureCount INTEGER NOT NULL)');
      await db.executeSql('INSERT OR IGNORE INTO proof VALUES (1,0,0)');
      await db.executeSql('UPDATE proof SET launches=launches+1,fixtureCount=? WHERE id=1',[count]);
      const rows=await db.querySql('SELECT launches,fixtureCount FROM proof WHERE id=1');rows.goToFirstRow();
      const launches=rows.getLong(0);rows.close();await db.close();
      const storeDb=await relationalStore.getRdbStore(this.context,{name:'agent-boundary-probe.db',securityLevel:relationalStore.SecurityLevel.S1});
      await storeDb.executeSql('PRAGMA synchronous=FULL');
      await storeDb.executeSql('CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      const port:AgentPersistenceV2={load:async()=>{const rows=await storeDb.querySql('SELECT value FROM snapshot WHERE id=1');try{return rows.goToFirstRow()?rows.getString(0):null;}finally{rows.close();}},commit:async(value:string)=>{await storeDb.executeSql('INSERT OR REPLACE INTO snapshot VALUES (1,?)',[value]);}};
      const fresh=await port.load()===null,fixture=acceptedFixture(fixtures),store=await AgentStoreV2.open({groupId:fixture.groupId,deviceId:fixture.deviceId,holderInstanceId:fixture.holderInstanceId,appInstanceId:fixture.appInstanceId},port);
      if(fresh){await store.change({apply:s=>{s.state=fixture;s.journal=bindAgentJournalV2(s.journal,'probe-coordinator',1);const factory:AgentMessageFactoryV2={id:()=>util.generateRandomUUID(true),digest:(text:string)=>text};const payload:Ack={messageId:'probe-origin'};s.journal.outbox.push(agentMessageV2(s.journal,s.state.groupId,s.state.holderInstanceId,'Ack',payload,factory,'probe-origin'));}});}
      const saved=store.read();if(saved.journal.outbox.length!==1||!fresh&&(saved.state.entries[0].record.state!=='CANCELLED_SETTLED'||!saved.state.entries[0].record.resourcesSettled))throw Error('NATIVE_RECOVERY_OR_OUTBOX_LOST');
      await storeDb.close();
      const result='PASS native ledger fixtures='+count+'; persisted launches='+launches+'; atomic ledger/outbox='+(fresh?'SEEDED':'RECOVERED');
      AppStorage.setOrCreate('probeResult',result);hilog.info(0x0001,'HarmonyProbe','%{public}s',result);
    }catch(e){const message='FAIL '+(e as Error).message;AppStorage.setOrCreate('probeResult',message);hilog.error(0x0001,'HarmonyProbe','%{public}s',message);}
  }
  onWindowStageCreate(stage:window.WindowStage):void {stage.loadContent('pages/Index');}
}
