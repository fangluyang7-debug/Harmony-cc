const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const {loadImageEncodingPack,packDigest}=require('@harmony/reference-capabilities');
// The converted model must accept the declared RGB input. Normalization is inside its graph.
async function packageImageEncoder(configFile,rawDir){
 const config=JSON.parse(await fs.readFile(configFile,'utf8')),base=path.dirname(configFile);
 const pack=await loadImageEncodingPack(path.resolve(base,config.suite));
 if(!pack.manifest.executorIds.includes('harmony.image.cpu.v1')||
    config.preprocessVersion!==pack.manifest.model.preprocessVersion||
    config.inputLayout!=='RGB_UINT8_NHWC_RESIZE'||!Number.isInteger(config.size)||config.size<1||config.size>1024)
   throw Error('HARMONY_ENCODER_CONVERSION_INVALID');
 const model=await fs.readFile(path.resolve(base,config.modelFile));
 if(!model.length||createHash('sha256').update(model).digest('hex')!==config.convertedSha256)throw Error('HARMONY_ENCODER_DIGEST');
 await fs.writeFile(path.join(rawDir,'image-encoder.ms'),model);
 await fs.writeFile(path.join(rawDir,'image-encoder.json'),JSON.stringify({convertedSha256:config.convertedSha256,size:config.size,
   inputLayout:config.inputLayout,preprocessVersion:config.preprocessVersion}));
 return {manifest:pack.manifest,digest:packDigest(pack),cases:pack.cases.map(c=>({...c,input:c.input.toString('base64')}))};
}
module.exports={packageImageEncoder};
