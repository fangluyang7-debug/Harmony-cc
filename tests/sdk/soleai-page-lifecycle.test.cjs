const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {transformSync}=require('esbuild');
const source=fs.readFileSync('apps/harmony/entry/src/main/ets/pages/Index.ets','utf8');
const body=source.match(/onPageHide\(\): void \{([^\n]+)\}/)[1];
const hide=new Function('TaskSignalType','clearInterval',transformSync(`function hide() {${body}}`,{loader:'ts'}).code+';return hide;')({PAGE_LEFT:'left'},()=>{});
test('system photo picker may hide the page without invalidating its pending result',()=>{
 let invalidations=0;
 const page={selectingPhoto:true,invalidate:()=>invalidations++,readyTimer:1};
 hide.call(page); assert.equal(invalidations,0);
 page.selectingPhoto=false; hide.call(page); assert.equal(invalidations,1);
});
