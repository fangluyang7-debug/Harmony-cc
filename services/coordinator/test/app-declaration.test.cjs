const {test}=require('node:test'),assert=require('node:assert/strict');
const {runtime}=require('./helpers.cjs');
const {validDeclaration}=require('../dist/app-declaration');
const declaration={version:1,revision:'shopping.1',workflows:[{id:'photo',capabilities:['image.crop.v1']}]};
test('declarations reject undeclared capabilities, duplicate workflows and unknown metadata',()=>{
 assert.equal(validDeclaration(declaration,['image.crop.v1']),true);
 assert.equal(validDeclaration(declaration,['text.count.v1']),false);
 assert.equal(validDeclaration({...declaration,workflows:[...declaration.workflows,...declaration.workflows]},['image.crop.v1']),false);
 assert.equal(validDeclaration({...declaration,credential:'secret'},['image.crop.v1']),false);
 const workflow={...declaration.workflows[0],inputSchema:'image.raster',outputContract:'image.raster',nodes:[{id:'prepare',capability:'image.crop.v1',dependsOn:[]}]};
 assert.equal(validDeclaration({...declaration,workflows:[workflow]},['image.crop.v1']),true);
 assert.equal(validDeclaration({...declaration,workflows:[{...workflow,nodes:[{...workflow.nodes[0],dependsOn:['prepare']}]}]},['image.crop.v1']),false);
});
test('owner approved declaration persists; rejected declarations create no installation and changed revisions require explicit policy reconciliation',async()=>{
 const r=await runtime();try{
  const invitation=await r.auth.invite('g','owner','phone',r.url),owner=await r.auth.exchange({inviteId:invitation.inviteId,code:invitation.code,holderInstanceId:'device-holder'});
  const input={label:'Shopping',allowedContracts:['image.crop.v1'],maxConcurrent:1,resources:[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:268435456}],offlineBase:[],onlineExtra:[],declaration};
  await assert.rejects(r.apps.register(owner.peer,{...input,declaration:{...declaration,workflows:[{id:'bad',capabilities:['unknown.v1']}]}},r.url),/APP_DECLARATION_INVALID/);
  assert.equal(await r.db.registeredInstallation.count(),0);
  const registration=await r.apps.register(owner.peer,input,r.url);
  const app=await r.db.registeredApp.findUnique({where:{id:registration.appId}});assert.deepEqual(JSON.parse(app.declarationJson),declaration);
  const installed=await r.apps.exchange({registrationId:registration.registrationId,code:registration.code});
  assert.equal((await r.apps.context(installed.peer)).identity.appId,registration.appId);
  await assert.rejects(r.apps.exchange({registrationId:registration.registrationId,code:registration.code}),/APP_INVITATION_INVALID/);
  await assert.rejects(r.apps.register(owner.peer,{...input,declaration:{...declaration,revision:'shopping.2'}},r.url),/APP_DECLARATION_CONFLICT/);
 }finally{await r.close();}
});

{
const {test}=require('node:test'),assert=require('node:assert/strict');
const {validDeclaration}=require('../dist/app-declaration');
const workflow=()=>({id:'shopping.text',capabilities:['chat.understand.v1','shopping.commit.v1'],inputSchema:'text.query',outputContract:'shopping.result',qualityTarget:'reference',nodes:[{id:'understand',capability:'chat.understand.v1',dependsOn:[],parameters:'{}',effects:'PURE'},{id:'commit',capability:'shopping.commit.v1',dependsOn:['understand'],effects:'COMMIT'}]});
const declaration=()=>({version:1,revision:'soleai.app.1',workflows:[workflow()]});
const valid=d=>validDeclaration(d,['chat.understand.v1','shopping.commit.v1']);
test('effects, parameters, dependencies and content-based quality are validated',()=>{
 assert.equal(valid(declaration()),true);
 for(const revision of ['soleai.app.1','other.app.42','legacy']){const d=declaration();d.revision=revision;delete d.workflows[0].qualityTarget;assert.equal(valid(d),false);}
 for(const mutate of [d=>delete d.workflows[0].qualityTarget,d=>d.workflows[0].nodes[1].effects='REMOTE',d=>d.workflows[0].nodes[0].parameters='[]',d=>d.workflows[0].nodes[0].dependsOn=['commit']]){const d=declaration();mutate(d);assert.equal(valid(d),false);}
 const old=declaration();old.revision='legacy';delete old.workflows[0].qualityTarget;old.workflows[0].nodes.forEach(n=>delete n.effects);assert.equal(valid(old),true);
});
test('alternatives require compatible complete paths without nesting',()=>{
 const d=declaration(),w=d.workflows[0];w.alternatives=[workflow()];delete w.nodes;assert.equal(valid(d),true);
 w.alternatives[0].outputContract='other';assert.equal(valid(d),false);
 w.alternatives[0]=workflow();w.alternatives[0].alternatives=[workflow()];assert.equal(valid(d),false);
});

}
