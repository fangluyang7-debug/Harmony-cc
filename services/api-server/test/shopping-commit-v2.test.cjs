require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Test}=require('@nestjs/testing');
const {UnauthorizedException}=require('@nestjs/common');
const {ConfigService}=require('@nestjs/config');
const {configureApp}=require('../dist/src/bootstrap/configure-app');
const http=require('supertest');
const {ShoppingCommitV2Controller,commitInputHash}=require('../dist/src/modules/sessions/controllers/shopping-commit-v2.controller');
const {PrismaService}=require('../dist/src/persistence/prisma/prisma.service');
const {SessionsService}=require('../dist/src/modules/sessions/application/sessions.service');
const {AuthService}=require('../dist/src/modules/auth/application/auth.service');
const {JwtTokenService}=require('../dist/src/modules/auth/application/jwt-token.service');

test('commit mints task-scoped tickets, writes once per idempotency key, replays instead of duplicating and dry-runs without writes',async()=>{
  const sessions=new Map(),assets=[],snapshots=[];let updates=0;
  const prisma={querySession:{findUnique:async({where})=>sessions.get(where.id)??null,create:async({data})=>{if(sessions.has(data.id))throw Error('P2002');sessions.set(data.id,{id:data.id,stateVersion:0,...data});},update:async({where,data})=>{updates++;Object.assign(sessions.get(where.id),data);}},
    imageAsset:{create:async({data})=>{assets.push(data);}}};
  const sessionService={writeRuntimeCandidateSnapshot:async(input)=>{snapshots.push(input);return 'cand_snap_'+snapshots.length;}};
  const users={'Bearer shopper':{userId:'u-shopper',email:'s@example.invalid'},'Bearer service-host':{userId:'u-service',email:'h@example.invalid'}};
  const config=new ConfigService();
  const module=await Test.createTestingModule({controllers:[ShoppingCommitV2Controller],providers:[
    {provide:ConfigService,useValue:config},{provide:PrismaService,useValue:prisma},{provide:SessionsService,useValue:sessionService},JwtTokenService,
    {provide:AuthService,useValue:{requireUserFromAuthorization(header){const u=users[header];if(!u)throw new UnauthorizedException();return u;}}}
  ]}).compile();
  const app=module.createNestApplication({bodyParser:false});configureApp(app);
  try{
    await app.init();
    const server=()=>http(app.getHttpServer());
    const seed=i=>({title:'t'+i,platformName:'ref',amount:String(100+i),currency:'CNY',shopName:'s',shopType:'t',stockStatus:'in_stock',coverImageUrl:'',productUrl:'https://ref.invalid/'+i,matchSummary:{},normalizedAttributes:{},rawPayload:{},recommendationReason:[]});
    const request={query:{text:'黑色跑鞋 500 以内',filters:{sortRule:'price_asc',priceMax:'500'}},candidates:[seed(0),seed(1)],answer:'找到 2 个候选'};
    const inputHash=commitInputHash(request);
    // The phone (logged-in shopper) mints a ticket bound to this workflow, this exact input and the commit capability.
    await server().post('/api/v2/tickets').set('Authorization','Bearer nobody').send({workflowId:'wf-1',inputHash,scope:['shopping.commit.v1']}).expect(401);
    assert.equal((await server().post('/api/v2/tickets').set('Authorization','Bearer shopper').send({workflowId:'wf-1',inputHash:'nope',scope:['shopping.commit.v1']}).expect(400)).body.error.code,'TICKET_REQUEST_INVALID');
    const {ticket,expiresAt}=(await server().post('/api/v2/tickets').set('Authorization','Bearer shopper').send({workflowId:'wf-1',inputHash,scope:['shopping.commit.v1'],ttlMs:30000}).expect(200)).body;
    assert.ok(typeof ticket==='string'&&ticket.split('.').length===3&&expiresAt>Date.now());
    // The service host executes with its own session; the ticket carries the shopper's authorization.
    const commit=(body,headers={})=>{let q=server().post('/api/v2/stages/commit').set('Authorization','Bearer service-host');for(const [k,v] of Object.entries(headers))q=q.set(k,v);return q.send(body);};
    assert.equal((await commit({...request,ticket}).expect(400)).body.error.code,'IDEMPOTENCY_KEY_REQUIRED');
    assert.equal((await commit({...request,ticket:'garbage'},{'idempotency-key':'op-1'}).expect(401)).body.error.code,'TICKET_INVALID');
    assert.equal((await commit({...request,answer:'tampered',ticket},{'idempotency-key':'op-1'}).expect(401)).body.error.code,'TICKET_INPUT_MISMATCH');
    const dry=(await commit({...request,ticket},{'idempotency-key':'op-1','x-dry-run':'true'}).expect(200)).body;
    assert.deepEqual(dry,{dryRun:true,sessionId:dry.sessionId,wouldCreate:true,writes:['imageAsset','querySession','filterSnapshot','candidateSnapshot'],candidateCount:2});
    assert.equal(sessions.size,0);assert.equal(assets.length,0);
    // Qualification dry runs use the literal dry-run ticket and are only accepted in dry-run mode.
    assert.equal((await commit({...request,ticket:'dry-run'},{'idempotency-key':'eval-1'}).expect(401)).body.error.code,'TICKET_INVALID');
    assert.equal((await commit({...request,ticket:'dry-run'},{'idempotency-key':'eval-1','x-dry-run':'true'}).expect(200)).body.dryRun,true);
    const first=(await commit({...request,ticket},{'idempotency-key':'op-1'}).expect(200)).body;
    assert.equal(first.created,true);assert.equal(first.sessionId,dry.sessionId);assert.equal(first.stateVersion,1);
    assert.equal(sessions.get(first.sessionId).userId,'u-shopper');assert.equal(sessions.get(first.sessionId).entrySource,'scheduler');assert.equal(assets[0].ownerUserId,'u-shopper');
    assert.equal(snapshots.length,1);assert.equal(snapshots[0].candidates.length,2);assert.equal(updates,1);
    // A retried or re-planned commit with the same key is a replay: same session, no second write.
    const again=(await commit({...request,ticket},{'idempotency-key':'op-1'}).expect(200)).body;
    assert.deepEqual(again,{dryRun:false,sessionId:first.sessionId,created:false,replay:true,stateVersion:1});
    assert.equal(sessions.size,1);assert.equal(snapshots.length,1);
    const dryAfter=(await commit({...request,ticket},{'idempotency-key':'op-1','x-dry-run':'true'}).expect(200)).body;
    assert.equal(dryAfter.wouldCreate,false);assert.deepEqual(dryAfter.writes,[]);
    // A different operation key is a different commit.
    const second=(await commit({...request,ticket},{'idempotency-key':'op-2'}).expect(200)).body;
    assert.equal(second.created,true);assert.notEqual(second.sessionId,first.sessionId);assert.equal(sessions.size,2);
    // An expired ticket is refused.
    const jwt=app.get(JwtTokenService);
    const expired=jwt.signScoped({kind:'service-ticket',sub:'u-shopper',wf:'wf-1',ih:inputHash,scope:['shopping.commit.v1'],jti:'x',exp:Math.floor(Date.now()/1000)-1});
    assert.equal((await commit({...request,ticket:expired},{'idempotency-key':'op-3'}).expect(401)).body.error.code,'TICKET_EXPIRED');
    const access=jwt.sign({userId:'u-shopper',email:'s@example.invalid'});
    assert.equal((await commit({...request,ticket:access},{'idempotency-key':'op-3'}).expect(401)).body.error.code,'TICKET_INVALID');
  }finally{await app.close();}
});
