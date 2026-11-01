import { canonical, LedgerIdentityV2, LedgerStateV2, LedgerAdmissionV2, DispatchOfferV2, AllotmentGrantV2, ResourceAmountV2, ExecutionReceiptV2,
  newLedgerV2, requestGrantV2, installGrantV2, admitV2, startAttemptV2, cancelAttemptV2, recoverLedgerV2, occupiedV2, ledgerPoolsV2, settleAttemptV2 } from 'scheduler';
interface Fixture { name:string;method:string;stateJSON:string;argJSON:string;expectedJSON:string;expectedError:string; }
interface Timed { id:string;now:number; }
interface Attempt { attemptId:string;now:number; }
interface Limits { limits:ResourceAmountV2[]; }
interface Settlement { receipt:ExecutionReceiptV2; }
interface Install { grant:AllotmentGrantV2;verified:boolean;now:number; }
interface Admit { offer:DispatchOfferV2;context:LedgerAdmissionV2; }
function execute(f:Fixture):Object {
 const state=JSON.parse(f.stateJSON) as LedgerStateV2;
 switch(f.method){
  case 'new':return newLedgerV2(JSON.parse(f.argJSON) as LedgerIdentityV2);
  case 'request':{const a=JSON.parse(f.argJSON) as Timed;return requestGrantV2(state,a.id,a.now);}
  case 'install':{const a=JSON.parse(f.argJSON) as Install;return installGrantV2(state,a.grant,a.verified,a.now);}
  case 'admit':{const a=JSON.parse(f.argJSON) as Admit;return admitV2(state,a.offer,a.context);}
  case 'start':{const a=JSON.parse(f.argJSON) as Attempt;return startAttemptV2(state,a.attemptId,a.now);}
  case 'cancel':return cancelAttemptV2(state,(JSON.parse(f.argJSON) as Attempt).attemptId);
  case 'recover':return recoverLedgerV2(state);
  case 'occupied':return occupiedV2(state);
  case 'pools':return ledgerPoolsV2(state,(JSON.parse(f.argJSON) as Limits).limits);
  case 'settle':return settleAttemptV2(state,(JSON.parse(f.argJSON) as Settlement).receipt);
  default:throw Error('UNKNOWN_FIXTURE_METHOD');
 }
}
export function runLedgerFixtures(text:string):number {
 const fixtures=JSON.parse(text) as Fixture[];
 for(const fixture of fixtures){
  let result='',error='';try{result=canonical(execute(fixture));}catch(e){error=(e as Error).message;}
  if(result!==fixture.expectedJSON||error!==fixture.expectedError)throw Error('FIXTURE_FAILED '+fixture.name+' '+error);
 }
 return fixtures.length;
}
/** Test-only accepted attempt, used to verify the platform persistence boundary across process death. */
export function acceptedFixture(text:string):LedgerStateV2 {
 const fixture=(JSON.parse(text) as Fixture[]).find(f=>f.name==='recover accepted cancels');
 if(fixture===undefined)throw Error('RECOVERY_FIXTURE_REQUIRED');return JSON.parse(fixture.stateJSON) as LedgerStateV2;
}
