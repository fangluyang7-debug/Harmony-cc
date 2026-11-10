import type {CpuExecutor} from './registry';
import {filterCatalog} from './catalog-kernel';
export const execute:CpuExecutor=async bytes=>{
 try{return {output:Buffer.from(JSON.stringify(filterCatalog(JSON.parse(bytes.toString('utf8'))))),schemaId:'catalog.ranked'};}
 catch{throw Error('CATALOG_INVALID');}
};
