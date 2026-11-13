const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('judge gallery updates original uploads without waiting for results and preserves loaded originals',()=>{
 class Element{
  children=[];dataset={};html='';className='';isConnected=true;
  set innerHTML(value){this.html=value;this.children=[];this.img=value.includes('<img ')?{}:null;}
  get innerHTML(){return this.html;}
  querySelector(s){return s==='img'?this.img:s==='.gallery-empty'&&this.html.includes('gallery-empty')?{}:null;}
  append(c){this.html='';c.parent=this;this.children.push(c);}
  replaceWith(c){const p=this.parent;c.parent=p;p.children[p.children.indexOf(this)]=c;this.isConnected=false;}
  remove(){this.parent.children.splice(this.parent.children.indexOf(this),1);}
  get lastChild(){return this.children.at(-1);}
 }
 const els={'source-gallery':new Element(),preview:new Element()};
 const source=fs.readFileSync('apps/team-space-web/photo-display.js','utf8'),code=source.slice(source.indexOf('function gallery('),source.indexOf('\nconst phases='));
 const ctx=vm.createContext({$:id=>els[id],document:{createElement:()=>new Element()},esc:String,signature:'',setTimeout});vm.runInContext(code,ctx);
 const round={id:'coop:real',inputs:[{name:'a',url:null},{name:'b',url:null}],results:[]};ctx.gallery(round);assert.match(els['source-gallery'].children[0].html,/正在接收原照片/);
 round.inputs[0].url='/images/a/input';ctx.gallery(round);const first=els['source-gallery'].children[0];assert.match(first.html,/src="\/images\/a\/input"/);assert.equal(round.results.length,0);
 round.inputs[1].url='/images/b/input';ctx.gallery(round);assert.equal(els['source-gallery'].children[0],first);assert.match(els['source-gallery'].children[1].html,/src="\/images\/b\/input"/);
 round.results.push({imageIndex:1,hash:'result-b',url:'/images/b/result'});ctx.gallery(round);assert.equal(els['source-gallery'].children[0],first);assert.match(els.preview.children[1].html,/已交付成品/);
});
