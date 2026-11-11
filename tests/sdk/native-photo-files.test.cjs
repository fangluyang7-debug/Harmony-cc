const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto'),{transformSync}=require('esbuild');
test('verified results remain private until explicit album save; corrupt results never create an album asset',async()=>{
 const files=new Map(),fds=new Map();let next=0,assets=0,released=0;
 const data=new Uint8Array([1,2,3]),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
 const fileIo={OpenMode:{CREATE:1,TRUNC:2,WRITE_ONLY:4,READ_ONLY:0},openSync:path=>{const fd=++next;fds.set(fd,path);return {fd};},closeSync:()=>{},writeSync:(fd,b)=>{files.set(fds.get(fd),new Uint8Array(b));return b.byteLength;},copyFileSync:(source,target)=>files.set(fds.get(target),files.get(fds.get(source)))};
 const photoAccessHelper={getPhotoAccessHelper:()=>({createAsset:async()=>{assets++;return 'gallery://result';},release:async()=>{released++;}}),PhotoType:{IMAGE:1}};
 const image={createImageSource:()=>({getImageInfo:async()=>({size:{width:768,height:512}}),release:async()=>{}})};
 const code=transformSync(fs.readFileSync('apps/harmony-photo/entry/src/main/ets/PhotoFiles.ets','utf8'),{loader:'ts',format:'cjs'}).code,m={exports:{}};
 new Function('require','module','exports',code)(name=>name==='@kit.CoreFileKit'?{fileIo}:name==='@kit.ImageKit'?{image}:name==='@kit.MediaLibraryKit'?{photoAccessHelper}:{hash,base64:{decodeSync:s=>new Uint8Array(Buffer.from(s,'base64'))}},m,m.exports);
 const product={version:1,format:'png',image:Buffer.from(data).toString('base64'),hash:hash(data),width:768,height:512},context={filesDir:'/private'};
 const result=await m.exports.storePhotoResult(context,JSON.stringify(product),'forest');
 assert.equal(assets,0);assert.deepEqual(files.get(result.path),data);
 await assert.rejects(m.exports.storePhotoResult(context,JSON.stringify({...product,hash:'wrong'}),'bad'),/PHOTO_RESULT_HASH/);assert.equal(assets,0);
 await m.exports.savePhotoToAlbum(context,result);assert.equal(assets,1);assert.equal(released,1);assert.deepEqual(files.get('gallery://result'),data);
});
