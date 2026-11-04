const {builtinCpuPacks,cpuConfiguration}=require('@harmony/reference-capabilities');
const base=builtinCpuPacks()[0],raw=Buffer.from('{"text":"graph"}'),counts=Buffer.from('{"characters":5,"words":1,"lines":1}');
function identityPack(id,schema,bytes){return {...base,maxOutputBytes:4096,manifest:{...base.manifest,packId:id,contract:{...base.manifest.contract,contractId:id,capability:id,serviceId:id,inputSchemas:[schema],outputSchemas:[schema]}},cases:[{id:'identity',input:bytes,parameters:'{}',config:cpuConfiguration,maxOutputBytes:4096}],evaluate:async(_c,out)=>out.equals(bytes)?1:0};}
module.exports={raw,counts,collect:identityPack('source.collect.v1','text.input',raw),final:identityPack('source.finish.v1','text.counts',counts)};
