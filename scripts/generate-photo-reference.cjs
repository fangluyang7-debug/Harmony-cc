// Maintainer operation: immutable synthetic qualification fixtures, never user task inputs.
const fs=require('node:fs'),path=require('node:path'),sharp=require('sharp'),{createHash}=require('node:crypto');
async function main(){
 const root=path.resolve(__dirname,'..'),config=JSON.parse(fs.readFileSync(path.join(root,'.test/photo-tools/runtime.json')));process.env.HARMONY_PHOTO_MODEL=config.model;process.env.HARMONY_PHOTO_RUNNER=config.runner;
 const engines=require('../services/pc-agent/dist/executors/photo'),{encodeBundle}=require('@harmony/reference-capabilities');
 const raw=Buffer.alloc(8*6*3);for(let y=0;y<6;y++)for(let x=0;x<8;x++){const i=(y*8+x)*3;raw[i]=(x*37+y*11)%256;raw[i+1]=(y*41)%256;raw[i+2]=((x+y)%2)*255;}
 const source=await sharp(raw,{raw:{width:8,height:6,channels:3}}).png().toBuffer(),configCpu={id:'standard',threads:1,batchSize:1,quality:'standard'},stages=[];
 async function stage(name,input,inputSchema,parameters={}){const result=await engines[name](input,parameters,configCpu);const record={capability:'photo.'+name+'.v1',inputSchema,outputSchema:result.schemaId,input:input.toString('base64'),parameters,expected:result.output.toString('base64')};if(inputSchema==='image.raster'){const jpeg=await sharp(input).jpeg({quality:95}).toBuffer();record.jpegInput=jpeg.toString('base64');record.jpegExpected=(await engines[name](jpeg,parameters,configCpu)).output.toString('base64');}stages.push(record);return result.output;}
 const analyzed=await stage('analyze',source,'image.raster'),tile=await stage('prepare',analyzed,'photo.source',{x:0,y:0,width:8,height:6}),enhanced=await stage('enhance',tile,'photo.tile');
 const assembled=await stage('assemble',encodeBundle([{nodeId:'enhance-0',schemaId:'photo.tile',data:enhanced}]),'artifact.bundle');await stage('deliver',assembled,'image.raster');
 const weightsHash=createHash('sha256').update(fs.readFileSync(path.join(config.model,'realesrgan-x4plus.bin'))).digest('hex');
 const result={version:1,provenance:'Real-ESRGAN x4plus official ncnn weights; fixed 8x6 RGB fixture. Golden CPU output is a conformance reference, not a perceptual-quality benchmark.',model:{modelId:'realesrgan-x4plus',version:'1',weightsHash,preprocessVersion:'rgb-unit-v1',embeddingKind:'image-rgb',dimension:3,dtype:'float32',normalization:'unit'},stages};
 const destination=path.join(root,'packages/reference-capabilities/fixtures/photo-reference.json');fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(result,null,2)+'\n');console.log('Qualification fixture created:',destination);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
