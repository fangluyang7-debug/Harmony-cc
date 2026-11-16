const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),path=require('node:path');
const {spawn}=require('node:child_process');
const {startDisplay}=require('../../scripts/photo-display-server.cjs');
const script=path.resolve(__dirname,'../../scripts/check-photo-display-modules.cjs');
const check=url=>new Promise(resolve=>{const p=spawn(process.execPath,['--experimental-vm-modules',script,url],{windowsHide:true});let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);p.on('exit',code=>resolve({code,output}));});
test('served photo page links every imported module, including planning and round history',async t=>{
 const display=await startDisplay({host:'127.0.0.1',port:0});t.after(()=>display.server.close());
 const result=await check(display.url);assert.equal(result.code,0,result.output);assert.match(result.output,/photo-execution-view.mjs/);assert.match(result.output,/photo-display-compare.mjs/);
});
test('deployment check rejects the exact old-module missing-export regression',async t=>{
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/javascript');res.end(req.url==='/photo-display.js'?"import {displayRounds} from './photo-display-compare.mjs';":"export function comparison(){}");});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const result=await check('http://127.0.0.1:'+server.address().port+'/');assert.notEqual(result.code,0);assert.match(result.output,/does not provide an export named 'displayRounds'/);
});
