// Read-only deployment check: link the served ES module graph without executing it.
// Run with: node --experimental-vm-modules scripts/check-photo-display-modules.cjs http://127.0.0.1:7460/
const vm=require('node:vm');
async function checkModules(base){
 if(!vm.SourceTextModule)throw Error('Use node --experimental-vm-modules');
 const origin=new URL(base).origin,context=vm.createContext({}),cache=new Map();
 const load=async url=>{
  if(new URL(url).origin!==origin)throw Error('EXTERNAL_MODULE');
  if(!cache.has(url))cache.set(url,(async()=>{
   const response=await fetch(url,{signal:AbortSignal.timeout(10000)});
   if(!response.ok)throw Error(`MODULE_HTTP_${response.status}: ${url}`);
   if(!/javascript/.test(response.headers.get('content-type')||''))throw Error(`MODULE_MIME: ${url}`);
   return new vm.SourceTextModule(await response.text(),{context,identifier:url});
  })());return cache.get(url);
 };
 const main=await load(new URL('photo-display.js',base).href);
 await main.link((specifier,ref)=>load(new URL(specifier,ref.identifier).href));
 return {linked:true,modules:[...cache.keys()].map(url=>new URL(url).pathname)};
}
module.exports={checkModules};
if(require.main===module)checkModules(process.argv[2]||'http://127.0.0.1:7460/').then(result=>console.log(JSON.stringify(result))).catch(e=>{console.error(e.message);process.exitCode=1;});
