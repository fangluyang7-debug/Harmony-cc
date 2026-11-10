export interface CatalogItem { id:string; price:string; currency:string; rank:number; }
export interface CatalogInput { currency:string; maxPriceMinor:number; items:CatalogItem[]; }
export interface RankedItem { id:string; priceMinor:number; rank:number; }
export interface CatalogOutput { scanned:number; excluded:number; items:RankedItem[]; }
export function priceMinor(value:string):number {
 if(typeof value!=='string'||!/^\d{1,9}(\.\d{1,2})?$/.test(value))throw Error('CATALOG_INVALID');
 const parts=value.split('.');return Number(parts[0])*100+Number(((parts[1]??'')+'00').slice(0,2));
}
export function filterCatalog(input:CatalogInput):CatalogOutput {
 if(!input||input.currency!=='CNY'||!Number.isSafeInteger(input.maxPriceMinor)||input.maxPriceMinor<0||input.maxPriceMinor>99999999999||!Array.isArray(input.items)||input.items.length>10000)throw Error('CATALOG_INVALID');
 const seen=new Set<string>(),items:RankedItem[]=[];
 for(const item of input.items){
  if(!item||typeof item.id!=='string'||item.id.length<1||item.id.length>160||seen.has(item.id)||typeof item.currency!=='string'||!Number.isSafeInteger(item.rank)||item.rank<0)throw Error('CATALOG_INVALID');
  seen.add(item.id);const amount=priceMinor(item.price);
  if(item.currency===input.currency&&amount<=input.maxPriceMinor)items.push({id:item.id,priceMinor:amount,rank:item.rank});
 }
 items.sort((a:RankedItem,b:RankedItem):number=>a.priceMinor-b.priceMinor||a.rank-b.rank||(a.id<b.id?-1:a.id>b.id?1:0));
 return {scanned:input.items.length,excluded:input.items.length-items.length,items};
}
