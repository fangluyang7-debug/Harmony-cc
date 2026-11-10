const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

test('unchanged live content retains click targets, while a cleared trace is restored',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../../../apps/team-space-web/dispatch-layout.js'),'utf8');
  const fn=source.slice(source.indexOf('export function replaceContent'),source.indexOf('// Route visual association')).replace('export ','');
  let writes=0;
  const root={childNodes:[],querySelectorAll:()=>[],contains:()=>false,set innerHTML(value){writes++;this.childNodes=[{value}];}};
  const context={document:{getElementById:()=>root,activeElement:null},drawTopology:()=>{}};
  vm.runInNewContext(fn,context);
  context.replaceContent('trace','ready');const target=root.childNodes[0];
  context.replaceContent('trace','ready');assert.equal(writes,1);assert.equal(root.childNodes[0],target);
  root.innerHTML='loading';context.replaceContent('trace','ready');assert.equal(writes,3);assert.equal(root.childNodes[0].value,'ready');
  context.replaceContent('trace','updated');assert.equal(writes,4);assert.equal(root.childNodes[0].value,'updated');
});
