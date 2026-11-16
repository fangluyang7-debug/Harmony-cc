// Local viewer cache; thumbnail bytes are not repeated in the 500 ms status snapshots.
class ExecutionPreviewCache{
 constructor(){this.rows=new Map();}
 put(id,p){
  if(typeof id!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(id))return false;
  const pair={};for(const side of ['input','output']){const v=p?.[side];if(!v||typeof v.image!=='string'||v.image.length>45000||!Number.isInteger(v.width)||!Number.isInteger(v.height)||v.width<1||v.width>256||v.height<1||v.height>192)return false;const b=Buffer.from(v.image,'base64');if(b.length>32768||b[0]!==255||b[1]!==216)return false;pair[side]=b;}
  this.rows.delete(id);this.rows.set(id,pair);while(this.rows.size>32)this.rows.delete(this.rows.keys().next().value);return true;
 }
 ids(){return [...this.rows.keys()];}
 get(id,side){return this.rows.get(id)?.[side];}
}
module.exports={ExecutionPreviewCache};
