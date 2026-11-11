import { SdkInput, SdkNode, SdkWorkflow } from 'scheduler';
/** Same photo DAG as the web client; placement belongs only to the coordinator. */
export function photoWorkflow(id:string,input:SdkInput,width:number,height:number):SdkWorkflow{
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>1048576||Math.max(width,height)>1920)throw Error('请选择不超过 100 万像素、长边不超过 1920 像素的原图。');
 const edge=Math.max(64,Math.ceil(Math.max(width,height)/2)),nodes:SdkNode[]=[{id:'analyze',capability:'photo.analyze.v1',executionScope:'ORIGIN_DEVICE',input,parameters:JSON.stringify({width,height}),dependsOn:[]}],sources:string[]=[];
 let i=0;
 for(let y=0;y<height;y+=edge)for(let x=0;x<width;x+=edge){
  const w=Math.min(edge,width-x),h=Math.min(edge,height-y),prepare='prepare-'+i,enhance='enhance-'+i;
  const iw=Math.min(width,x+w+16)-Math.max(0,x-16),ih=Math.min(height,y+h+16)-Math.max(0,y-16);
  nodes.push({id:enhance,capability:'photo.enhance.v1',inputFrom:'analyze',parameters:JSON.stringify({x,y,width:w,height:h,pixels:iw*ih}),dependsOn:['analyze']});sources.push(enhance);i++;
 }
 nodes.push({id:'deliver',capability:'photo.deliver.v1',executionScope:'ORIGIN_DEVICE',inputFroms:sources,parameters:JSON.stringify({width:width*4,height:height*4,assemble:true}),dependsOn:sources});
 return {version:3,id,outputContract:'photo.product',qualityTarget:'reference',nodes};
}
