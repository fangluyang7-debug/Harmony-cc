import {deflateSync} from 'node:zlib';
import type {ReferencePack,ReferenceCase} from './index';
interface Picture {id:string;width:number;height:number;rgb:Buffer;}
function encoded(images:Picture[],pairs:number[][]){
 const parts:Buffer[]=[];const u32=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);parts.push(b);};u32(images.length);u32(pairs.length);
 for(const im of images){u32(Buffer.byteLength(im.id));parts.push(Buffer.from(im.id));u32(im.width);u32(im.height);parts.push(im.rgb);}for(const pair of pairs){u32(pair[0]);u32(pair[1]);}
 const raw=Buffer.concat(parts),header=Buffer.alloc(8);header.write('HVG1');header.writeUInt32LE(raw.length,4);return Buffer.concat([header,deflateSync(raw)]);
}
export function validVisualEvidence(bytes:Buffer){try{const r=JSON.parse(bytes.toString());return r.algorithm==='dense-hog-rgb-graph-v1'&&Array.isArray(r.pairs)&&r.pairs.length>0&&r.pairs.length<=128&&r.pairs.every((p:any)=>typeof p.a==='string'&&typeof p.b==='string'&&['scoreMillion','textureMillion','colorMillion'].every(k=>Number.isSafeInteger(p[k])&&p[k]>=0&&p[k]<=1000000)&&['featuresA','featuresB','comparisons','distinctMatches'].every(k=>Number.isSafeInteger(p[k])&&p[k]>=0));}catch{return false;}}
export function visualPack():ReferencePack {
 const config={id:'standard',threads:1,batchSize:1,quality:'standard'};
 const picture=(id:string,size:number,checker=false):Picture=>{const rgb=Buffer.alloc(size*size*3,255);if(checker)for(let y=0;y<size;y++)for(let x=0;x<size;x++)if((Math.floor(x/4)+Math.floor(y/4))%2)rgb.fill(0,(y*size+x)*3,(y*size+x)*3+3);return {id,width:size,height:size,rgb};};
 const row=(a:string,b:string,texture:boolean)=>({a,b,scoreMillion:texture?1000000:0,textureMillion:texture?1000000:0,colorMillion:1000000,featuresA:texture?1:0,featuresB:texture?1:0,comparisons:texture?1:0,distinctMatches:0});
 const make=(id:string,images:Picture[],pairs:number[][],expected:any,covers:string[]=[]):ReferenceCase=>({id,input:encoded(images,pairs),parameters:'{}',config,maxOutputBytes:60000,covers:['schema:image.visual-bundle',...covers],expected:{algorithm:'dense-hog-rgb-graph-v1',pairs:expected},expect:{kind:'OUTPUT'}});
 const many=Array.from({length:32},(_,i)=>picture('p'+i,32)),pairs:number[][]=[];for(let a=0;a<32&&pairs.length<128;a++)for(let b=a+1;b<32&&pairs.length<128;b++)pairs.push([a,b]);
 const cases:ReferenceCase[]=[make('identical-texture',[picture('a',32,true),picture('b',32,true)],[[0,1]],[row('a','b',true)]),
  make('no-texture',[picture('a',32),picture('b',32)],[[0,1]],[row('a','b',false)]),
  make('max-dimensions',[picture('a',512),picture('b',512)],[[0,1]],[row('a','b',false)],['boundary:max']),
  make('max-counts',many,pairs,pairs.map(([a,b])=>row('p'+a,'p'+b,false)),['boundary:max']),
  {id:'empty',input:Buffer.from('HVG1'),parameters:'{}',config,maxOutputBytes:60000,covers:['schema:image.visual-bundle','boundary:empty'],expect:{kind:'REJECT',errorCode:'VISUAL_INVALID'}},
  {id:'duplicate-pair',input:encoded([picture('a',32),picture('b',32)],[[0,1],[0,1]]),parameters:'{}',config,maxOutputBytes:60000,covers:['schema:image.visual-bundle'],expect:{kind:'REJECT',errorCode:'VISUAL_INVALID'}}];
 return {manifest:{packId:'image.visual-match.v1',contract:{contractId:'image.visual-match.v1',version:1,capability:'image.visual-match.v1',inputSchemas:['image.visual-bundle'],outputSchemas:['image.visual-evidence'],sideEffectPolicy:'PURE',interruptibility:'CANCEL_RESTART',maxNonPreemptibleMs:null},executorIds:['node.cpu.v1','harmony.cpu.v1'],model:null,suiteId:'visual.appearance.reference',qualityThreshold:1,resourceLimit:[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:134217728}]},cases,maxOutputBytes:60000,evaluate:async(test,output)=>validVisualEvidence(output)&&JSON.stringify(JSON.parse(output.toString()))===JSON.stringify(test.expected)?1:0};
}
