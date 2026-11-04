require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {Test}=require('@nestjs/testing');
const {UnauthorizedException}=require('@nestjs/common');
const {ConfigService}=require('@nestjs/config');
const {configureApp}=require('../dist/src/bootstrap/configure-app');
const http=require('supertest');
const product='../dist/src/modules/product-pool/';
const {activateIndex}=require(product+'application/image-search-index');
const {ImageSearchV2Controller}=require(product+'controllers/image-search-v2.controller');
const {LocalImageWorkerClientService}=require(product+'application/local-image-worker-client.service');
const {AuthService}=require('../dist/src/modules/auth/application/auth.service');

test('business session searches pinned vector and image spaces across index activation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'soleai-index-')),old=process.env.SOLEAI_IMAGE_INDEX_DIR;
  const model={modelId:'fixture',version:'v1',weightsHash:'a'.repeat(64),preprocessVersion:'rgb',embeddingKind:'image',dimension:2,dtype:'float32',normalization:'l2'};
  const index={model,indexSpaceId:'fixture',version:'one',entries:[{productId:'p',vector:[1,0]}]};
  const quality=[{vector:[1,0],expectedProductId:'p'}];
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';
  let workerModel=model;
  const module=await Test.createTestingModule({controllers:[ImageSearchV2Controller],providers:[
    {provide:ConfigService,useValue:new ConfigService()},
    {provide:AuthService,useValue:{requireUserFromAuthorization(header){if(header!=='Bearer business')throw new UnauthorizedException();return {id:'tester'};}}},
    {provide:LocalImageWorkerClientService,useValue:{post(path,body){assert.equal(path,'/v2/images/embed');assert.equal(body.imageBase64,png);return Promise.resolve({model:workerModel,vector:[1,0]});}}}
  ]}).compile();
  const app=module.createNestApplication({bodyParser:false});configureApp(app);process.env.SOLEAI_IMAGE_INDEX_DIR=root;
  try{
    await app.init();
    const {loadImageEncodingPack,cpuSchemas}=require('@harmony/reference-capabilities');
    const suiteFile=join(root,'encoder-suite.json');
    await require('node:fs/promises').writeFile(suiteFile,JSON.stringify({model,executorIds:['fixture.image'],minimumCosine:0.98,memoryBytes:67108864,
      cases:[{id:'png',imageBase64:png,vector:[1,0]}]}));
    const pack=await loadImageEncodingPack(suiteFile);
    const encode=vector=>Buffer.from(JSON.stringify({model,vector}));
    assert.equal(await pack.evaluate(pack.cases[0],encode([1,0])),1);
    assert.equal(await pack.evaluate(pack.cases[0],encode([0,1])),0);
    assert.equal(await cpuSchemas.get('image.embedding:1')(encode([2,0])),false);
    const query={model,indexSpaceId:'fixture',requestId:'request',topK:1};
    const send=(route,b,auth='Bearer business')=>http(app.getHttpServer()).post('/api/v2/image-search/'+route).set('Authorization',auth).send({...query,...b});
    await send('vector',{vector:[1,0]},'Bearer coordinator').expect(401);
    assert.equal((await send('vector',{vector:[1,0]}).expect(503)).body.error.code,'IMAGE_V2_INDEX_UNAVAILABLE');
    await activateIndex(root,index,quality);
    const spaces=http(app.getHttpServer());
    await spaces.get('/api/v2/image-search/spaces/fixture').expect(401);
    assert.deepEqual((await spaces.get('/api/v2/image-search/spaces/fixture').set('Authorization','Bearer business').expect(200)).body,
      {indexSpaceId:'fixture',indexVersion:'one',model});
    const v=(await send('vector',{vector:[1,0]}).expect(200)).body;
    const image=(await send('image',{imageBase64:png}).expect(200)).body;
    assert.deepEqual(image.candidates,v.candidates);assert.deepEqual(v.candidates,[{productId:'p',score:1}]);
    // Run the App service source with only native picker, file, auth and HTTP kit boundaries replaced.
    const file=require('node:fs').readFileSync(join(__dirname,'../../../apps/harmony/entry/src/main/ets/services/V2ImageSearch.ets'),'utf8');
    const compiled=require('esbuild').transformSync(file,{loader:'ts',format:'cjs'}).code;
    let selected=true,closed=0;
    const adapters={
      '@kit.MediaLibraryKit':{photoAccessHelper:{PhotoViewMIMETypes:{IMAGE_TYPE:'image'},PhotoViewPicker:class{async select(){return {photoUris:selected?['fixture.png']:[]};}}}},
      '@kit.CoreFileKit':{fileIo:{OpenMode:{READ_ONLY:0},openSync:()=>({fd:1}),statSync:()=>({size:Buffer.from(png,'base64').length}),
        readSync:(_,buffer)=>Buffer.from(png,'base64').copy(Buffer.from(buffer)),closeSync:()=>closed++}},
      scheduler:require('@harmony/scheduler-core'),
      '@kit.ArkTS':{util:{TextDecoder:class{decodeToString(bytes){return Buffer.from(bytes).toString();}},generateRandomUUID:()=> 'app-request',Base64Helper:class{encodeToStringSync(bytes){return Buffer.from(bytes).toString('base64');}}}},
      './CloudApiConfig':{CloudApiConfig:{getBaseUrl:()=> 'https://business.test',ensureGuest:async()=>{},requestHeaders:()=>({Authorization:'Bearer business'})}},
      '@kit.NetworkKit':{http:{RequestMethod:{GET:'get',POST:'post'},createHttp:()=>({destroy(){},async request(address,opts){
        const req=http(app.getHttpServer())[opts.method](new URL(address).pathname).set(opts.header);
        if(opts.extraData)req.send(JSON.parse(opts.extraData));
        const response=await req;return {result:response.text,responseCode:response.status};
      }})}}
    };
    const native={exports:{}};
    new Function('module','require',compiled)(native,id=>{assert.ok(adapters[id],id);return adapters[id];});
    const fromApp=await native.exports.searchSelectedImage('fixture');
    assert.deepEqual(fromApp.candidates,v.candidates);assert.equal(closed,1);
    if(process.env.HARMONY_IMAGE_TEAM_TEST==='1'){
      adapters['@kit.ArkTS'].util.generateRandomUUID=()=>require('node:crypto').randomUUID();
      await require('./image-search-team.cjs')(root,model,png,target=>native.exports.searchSelectedImage('fixture',target),v.candidates);
      adapters['@kit.ArkTS'].util.generateRandomUUID=()=> 'app-request';
      assert.equal(closed,3);
    }
    const priorClosed=closed;selected=false;assert.equal(await native.exports.searchSelectedImage('fixture'),null);assert.equal(closed,priorClosed);
    selected=true;
    for(const targetId of [undefined,'phone-fixture','pc-fixture','wrong-model']){
      const digest=bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex');
      const output=Buffer.from(JSON.stringify({model:targetId==='wrong-model'?{...model,version:'other'}:model,vector:[1,0]}));
      let staged=false,directWrites=0,received=false;
      const sdk=new (require('@harmony/scheduler-client').SchedulerSdk)({
        now:Date.now,digest,stageInput:async(_,bytes)=>{assert.deepEqual(Buffer.from(bytes),Buffer.from(png,'base64'));staged=true;},
        writeDirect:async()=>{directWrites++;},read:async()=>output,request:async(route,body)=>{
          if(route==='/v2/sdk/jobs'){
            const submission=JSON.parse(body),node=submission.workflow.nodes[0];
            assert.equal(node.targetId,targetId);assert.equal(node.capability,'image.encode.v1');
            assert.deepEqual(JSON.parse(node.parameters),model);assert.equal(staged,true);
            assert.ok(!body.includes('Bearer'));
            return JSON.stringify({jobId:'app-request',inputDelivery:targetId==='pc-fixture'?'DIRECT':'LOCAL',
              inputEndpointId:'peer',inputTicket:{ref:node.input,bytes:node.input.bytes,operation:'WRITE'}});
          }
          if(route.endsWith('/start'))return '{}';
          if(route.endsWith('/received')){received=true;return '{}';}
          return JSON.stringify({jobId:'app-request',targetId:targetId??'auto-selected',state:'SUCCEEDED',outputTicket:{bytes:output.length,ref:{contentHash:digest(output)}}});
        }
      });
      const running=native.exports.searchSelectedImage('fixture',{sdk,targetId});
      if(targetId==='wrong-model')await assert.rejects(running,/IMAGE_V2_MODEL_MISMATCH/);
      else {const result=await running;assert.deepEqual(result.candidates,v.candidates);assert.equal(result.encodingTargetId,targetId??'auto-selected');}
      assert.equal(received,true);assert.equal(directWrites,targetId==='pc-fixture'?1:0);
    }
    assert.deepEqual((await send('vector',{vector:[1,0],filters:{category:'absent'}}).expect(200)).body.candidates,[]);
    await send('vector',{vector:[1,1]}).expect(400);
    workerModel={...model,weightsHash:'b'.repeat(64)};
    await send('image',{imageBase64:png}).expect(409);
    await send('vector',{model:workerModel,vector:[1,0]}).expect(409);
    await assert.rejects(activateIndex(root,{...index,version:'two'},[{vector:[1,0],expectedProductId:'absent'}]),/QUALITY_FAILED/);
    assert.equal((await send('vector',{vector:[1,0]})).body.indexVersion,'one');
    await activateIndex(root,{...index,version:'two'},quality);
    assert.equal((await send('vector',{vector:[1,0]})).body.indexVersion,'two');
  }finally{await app.close();if(old===undefined)delete process.env.SOLEAI_IMAGE_INDEX_DIR;else process.env.SOLEAI_IMAGE_INDEX_DIR=old;await rm(root,{recursive:true,force:true});}
});
