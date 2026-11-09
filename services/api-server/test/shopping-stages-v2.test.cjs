require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Test}=require('@nestjs/testing');
const {UnauthorizedException}=require('@nestjs/common');
const {ConfigService}=require('@nestjs/config');
const {configureApp}=require('../dist/src/bootstrap/configure-app');
const http=require('supertest');
const {ShoppingStagesV2Controller}=require('../dist/src/modules/product-pool/controllers/shopping-stages-v2.controller');
const {PrismaService}=require('../dist/src/persistence/prisma/prisma.service');
const {AuthService}=require('../dist/src/modules/auth/application/auth.service');

test('read-only shopping stages answer by catalogue facts, reject bad input and never write',async()=>{
  const updated=new Date('2026-11-09T00:00:00Z');
  const catalogue=[{id:'p-a',platform:'ref',productUrl:'https://ref.invalid/a',priceAmount:'299.00',currency:'CNY',stockStatus:'in_stock',updatedAt:updated},
    {id:'p-b',platform:'ref',productUrl:'https://ref.invalid/b',priceAmount:'99.50',currency:'CNY',stockStatus:'weird',updatedAt:updated}];
  let writes=0;const prisma={product:{findMany:async({where})=>catalogue.filter(p=>where.OR.some(c=>c.id?c.id.in.includes(p.id):c.productUrl.in.includes(p.productUrl))),create:async()=>{writes++;},update:async()=>{writes++;}}};
  const module=await Test.createTestingModule({controllers:[ShoppingStagesV2Controller],providers:[
    {provide:ConfigService,useValue:new ConfigService()},
    {provide:PrismaService,useValue:prisma},
    {provide:AuthService,useValue:{requireUserFromAuthorization(header){if(header!=='Bearer business')throw new UnauthorizedException();return {id:'tester'};}}}
  ]}).compile();
  const app=module.createNestApplication({bodyParser:false});configureApp(app);
  try{
    await app.init();
    const send=(route,body,auth='Bearer business')=>http(app.getHttpServer()).post('/api/v2/stages/'+route).set('Authorization',auth).send(body);
    await send('price-stock',{requestId:'r',items:[]},'Bearer other').expect(401);
    const priced=(await send('price-stock',{requestId:'r',items:[{productId:'p-a',score:0.9},{productId:'missing'},{platformName:'ref',productUrl:'https://ref.invalid/b'}]}).expect(200)).body;
    assert.equal(priced.priceSource,'catalog');assert.equal(priced.items.length,3);
    assert.deepEqual(priced.items[0],{productId:'p-a',platformName:'ref',productUrl:'https://ref.invalid/a',score:0.9,amount:'299.00',currency:'CNY',stockStatus:'in_stock',catalogUpdatedAt:updated.toISOString()});
    assert.deepEqual(priced.items[1],{productId:'missing',platformName:null,productUrl:null,score:null,amount:null,currency:null,stockStatus:'unknown',catalogUpdatedAt:null});
    assert.equal(priced.items[2].stockStatus,'unknown');assert.equal(priced.items[2].amount,'99.50'); // unknown stock state is normalised, price kept
    const fromList=(await send('price-stock',{requestId:'r',candidates:[{productId:'p-a',score:1}]}).expect(200)).body;assert.equal(fromList.items[0].amount,'299.00');
    assert.equal((await send('price-stock',{requestId:'r',items:[{score:1}]}).expect(400)).body.error.code,'STAGE_INPUT_INVALID');
    assert.equal((await send('price-stock',{requestId:'r',items:new Array(201).fill({productId:'x'})}).expect(400)).body.error.code,'STAGE_INPUT_INVALID');
    const seed=(i,amount,stockStatus='in_stock')=>({title:'t'+i,platformName:'ref',amount,currency:'CNY',shopName:'s',shopType:'t',stockStatus,coverImageUrl:'',productUrl:'https://ref.invalid/'+i,matchSummary:{},normalizedAttributes:{},rawPayload:{},recommendationReason:[]});
    const items=[seed(0,'299.00'),seed(1,'99.5','out_of_stock'),seed(2,'1299'),seed(2,'1299'),seed(3,'0.99')];
    const ranked=(await send('rank',{requestId:'r',items,filters:{sortRule:'price_asc'}}).expect(200)).body.items;
    assert.deepEqual(ranked.map(x=>x.amount),['0.99','99.5','299.00','1299']);
    const inStock=(await send('rank',{requestId:'r',items,filters:{stockOnly:true,priceMax:'500'}}).expect(200)).body.items;
    assert.deepEqual(inStock.map(x=>x.productUrl),['https://ref.invalid/0','https://ref.invalid/3']);
    assert.equal((await send('rank',{requestId:'r',items:[{title:'x'}]}).expect(400)).body.error.code,'STAGE_INPUT_INVALID');
    assert.equal((await send('rank',{requestId:'r',items,filters:{sortRule:'random'}}).expect(400)).body.error.code,'STAGE_INPUT_INVALID');
    assert.equal(writes,0);
  }finally{await app.close();}
});
