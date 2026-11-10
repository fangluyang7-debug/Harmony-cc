import {bytes,text} from '../NativePlatform';
import {EngineInput,EngineResult} from './Types';
import {CatalogInput,filterCatalog} from './CatalogKernel';
export async function execute(request:EngineInput):Promise<EngineResult>{
 try{return {data:bytes(JSON.stringify(filterCatalog(JSON.parse(text(request.input)) as CatalogInput))),schemaId:'catalog.ranked'};}
 catch{throw Error('CATALOG_INVALID');}
}
