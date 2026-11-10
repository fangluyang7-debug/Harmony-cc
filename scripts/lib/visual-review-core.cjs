// Local rehearsal runs the same orchestration source compiled into the HAR.
const fs=require('node:fs'),path=require('node:path'),{transformSync}=require('esbuild');
const source=fs.readFileSync(path.resolve(__dirname,'../../apps/harmony/scheduler/src/main/ets/v2/client/VisualReviewFlow.ets'),'utf8');
const code=transformSync(source,{loader:'ts',format:'cjs',target:'node22'}).code;
const core={exports:{}};new Function('module','exports',code)(core,core.exports);module.exports=core.exports;
