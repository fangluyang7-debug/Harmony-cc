const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createHash}=require('node:crypto');
const {packageImageEncoder}=require('../../scripts/package-harmony-image-encoder.cjs');
const hash=v=>createHash('sha256').update(v).digest('hex');
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';
test('converted artifact is hash-bound; native adapter validates tensors and emits the registered space',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ms-encoder-'));
 try{
  const model={modelId:'fixture',version:'one',weightsHash:'a'.repeat(64),preprocessVersion:'rgb-resize',embeddingKind:'image',dimension:2,dtype:'float32',normalization:'l2'};
  const file=path.join(dir,'conversion.json'),weights=Buffer.from('simulated model bytes');
  const cfg={suite:'suite.json',modelFile:'converted.ms',convertedSha256:hash(weights),size:1,inputLayout:'RGB_UINT8_NHWC_RESIZE',preprocessVersion:'rgb-resize'};
  await fs.writeFile(file,JSON.stringify(cfg));await fs.writeFile(path.join(dir,'converted.ms'),weights);
  await fs.writeFile(path.join(dir,'suite.json'),JSON.stringify({model,executorIds:['harmony.image.cpu.v1'],minimumCosine:.98,memoryBytes:67108864,cases:[{id:'red',imageBase64:png,vector:[.6,.8]}]}));
  const pack=await packageImageEncoder(file,dir);assert.deepEqual(pack.manifest.model,model);
  let predictions=0,releases=0;
  const adapter={
    '../platform/NativeTransport':{bytes:s=>Buffer.from(s),hash,text:v=>Buffer.from(v).toString()},
    '../protocol/ResourcesV2':require('@harmony/scheduler-core'),
    '@kit.ImageKit':{image:{PixelMapFormat:{RGBA_8888:1},createImageSource:()=>({
      getImageInfo:async()=>({size:{width:1,height:1}}),release:async()=>{releases++;},
      createPixelMap:async()=>({getImageInfo:async()=>({size:{width:1,height:1}}),release:async()=>{releases++;},
        readPixelsToBuffer:async b=>new Uint8Array(b).set([20,40,60,255])})
    })}},
    '@ohos.ai.mindSporeLite':{ThreadAffinityMode:{NO_AFFINITIES:0},DataType:{NUMBER_TYPE_UINT8:37,NUMBER_TYPE_FLOAT32:43},
      loadModelFromBuffer:async(data,context)=>{
        assert.deepEqual(Buffer.from(data),weights);assert.deepEqual(context.target,['cpu']);
        return {getInputs:()=>[{dtype:37,shape:[1,1,1,3],setData:b=>assert.deepEqual([...new Uint8Array(b)],[20,40,60])}],
          predict:async()=>{predictions++;return [{dtype:43,getData:()=>new Float32Array([3,4]).buffer}];}};
      }}
  };
  const source=await fs.readFile(path.resolve(__dirname,'../../apps/harmony/scheduler/src/main/ets/v2/host/ImageEncoder.ets'),'utf8');
  const js=require('esbuild').transformSync(source,{loader:'ts',format:'cjs'}).code,native={exports:{}};
  new Function('module','require',js)(native,id=>{assert.ok(adapter[id],id);return adapter[id];});
  const encode=(expected=model)=>native.exports.encodeImage({resourceManager:{getRawFileContent:async f=>new Uint8Array(await fs.readFile(path.join(dir,f)))}},
    new Uint8Array(Buffer.from(png,'base64')),JSON.stringify(expected),model,()=>false);
  assert.deepEqual(JSON.parse(Buffer.from(await encode())),{model,vector:[.6,.8]});assert.equal(releases,2);
  await assert.rejects(encode({...model,version:'other'}),/MODEL_MISMATCH/);
  await fs.writeFile(path.join(dir,'image-encoder.ms'),'different');await assert.rejects(encode(),/MODEL_DIGEST/);
  assert.equal(predictions,1);
  await fs.writeFile(file,JSON.stringify({...cfg,convertedSha256:'b'.repeat(64)}));await assert.rejects(packageImageEncoder(file,dir),/ENCODER_DIGEST/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
