const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {fixture}=require('./native-coordinator-fixture.cjs');
const root='apps/harmony/scheduler/src/main/ets/v2/coordinator/';
async function setup(){
 const f=fixture();f.device('phone','device-holder');
 const pairing=new (f.load(root+'CoordinatorPairing.ets').CoordinatorPairing)(f.database,{certificate:'fixture',fingerprint:'fixture'},'REAL');
 const installation=randomUUID(),invite=await pairing.invite('g','p','phone','https://localhost:7443');
 const first=await pairing.exchange(invite.inviteId,invite.code,'device-holder',installation);
 f.sql.prepare('INSERT INTO RegisteredInstallation(id,appId,groupId,principalId,deviceId,holderInstanceId,state,expiresAt,offlineJson,onlineJson) VALUES(?,?,?,?,?,?,?,?,?,?)').run('photo-app','photo','g','p','phone','photo-holder','ACTIVE',Date.now()+60000,'{}','{}');
 const job={state:'HOLDER_RECORD_MISSING',holder:'photo-holder',offer:{task:{coordinatorEpoch:11,groupId:'g',contract:{sideEffectPolicy:'PURE'}}}};
 f.sql.prepare('INSERT INTO CpuJob(id,groupId,principalId,sourceHolderId,state,metadataJson) VALUES(?,?,?,?,?,?)').run('deliver','g','p','photo-holder',job.state,JSON.stringify(job));
 f.sql.prepare('INSERT INTO Attempt(id,groupId,workflowId,nodeId,executionDigest,state,holderInstanceId,taskJson) VALUES(?,?,?,?,?,?,?,?)').run('deliver','g','deliver','deliver','digest',job.state,'photo-holder','{}');
 f.sql.prepare('INSERT INTO Outbox(id,sequence,groupId,attemptId,kind,epoch,messageJson) VALUES(?,?,?,?,?,?,?)').run('offer',1,'g','deliver','DispatchOffer',11,'{}');
 f.sql.prepare('INSERT INTO AppJobReservation(id,appId,groupId,principalId,appInstanceId,resourcesJson,deadlineAt) VALUES(?,?,?,?,?,?,?)').run('deliver','photo','g','p','photo-app','[]',Date.now()-1000);
 f.device('new-phone','new-holder');const next=await pairing.invite('g','p','new-phone','https://localhost:7443');
 const helper=f.load(root+'CoordinatorUnadmitted.ets');
 return {...f,pairing,first,job,close:epoch=>f.database.transaction(tx=>helper.closeRetiredUnadmitted(tx,epoch)),rejoin:()=>pairing.exchange(next.inviteId,next.code,'new-holder',installation,'phone',['phone'])};
}
test('old missing photo delivery closes without fabricated receipts and permits rejoin of the same space',async()=>{
 const f=await setup();await assert.rejects(f.rejoin(),/SPACE_SWITCH_BUSY/);await f.close(12);await f.close(12);
 const a=f.sql.prepare('SELECT state,recordJson FROM Attempt').get();assert.equal(a.state,'CANCELLED');assert.equal(a.recordJson,null);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM Receipt').get().n,0);
 assert.equal(f.sql.prepare('SELECT superseded FROM Outbox').get().superseded,1);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM AppJobReservation').get().n,1,'historical reservation retained');
 const j=JSON.parse(f.sql.prepare('SELECT metadataJson FROM CpuJob').get().metadataJson);assert.equal(j.recoveryClosure.previousState,'HOLDER_RECORD_MISSING');
 assert.equal((await f.rejoin()).peer.deviceId,'new-phone');
 assert.equal(f.sql.prepare('SELECT revoked FROM Credential WHERE id=?').get(f.first.peer.credentialId).revoked,1);
 assert.equal(f.sql.prepare('SELECT state FROM RegisteredInstallation').get().state,'REVOKED');
});
test('same epoch, admitted execution, unknown offers and side effects remain blocked',async()=>{
 for(const kind of ['same-epoch','admitted','unknown','side-effect']){
  const f=await setup();
  if(kind==='admitted')f.sql.prepare('UPDATE Attempt SET recordJson=?').run(JSON.stringify({resourcesSettled:false}));
  if(kind==='unknown')f.sql.exec("UPDATE Attempt SET state='OFFERED'");
  if(kind==='side-effect'){f.job.offer.task.contract.sideEffectPolicy='COMMIT';f.sql.prepare('UPDATE CpuJob SET metadataJson=?').run(JSON.stringify(f.job));}
  await f.close(kind==='same-epoch'?11:12);await assert.rejects(f.rejoin(),/SPACE_SWITCH_BUSY/,kind);
  assert.equal(f.sql.prepare('SELECT revoked FROM Credential WHERE id=?').get(f.first.peer.credentialId).revoked,0);
 }
});
test('leave uses the same closure rule and later admission overrides closure',async()=>{
 const f=await setup();await assert.rejects(f.pairing.leave(f.first.peer),/SPACE_SWITCH_BUSY/);await f.close(12);
 f.sql.prepare('UPDATE Attempt SET recordJson=?').run(JSON.stringify({resourcesSettled:false}));await assert.rejects(f.rejoin(),/SPACE_SWITCH_BUSY/);
 f.sql.prepare('UPDATE Attempt SET recordJson=NULL').run();await f.pairing.leave(f.first.peer);
 assert.equal(f.sql.prepare('SELECT revoked FROM Credential WHERE id=?').get(f.first.peer.credentialId).revoked,1);
});
test('cancelled before dispatch releases reservation but an unknown missing attempt does not',async()=>{
 const f=await setup();f.sql.exec('DELETE FROM Attempt');await assert.rejects(f.rejoin(),/SPACE_SWITCH_BUSY/);
 f.sql.exec("UPDATE CpuJob SET state='CANCELLED'");assert.equal((await f.rejoin()).peer.deviceId,'new-phone');
});
