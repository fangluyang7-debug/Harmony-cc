import {common} from '@kit.AbilityKit';
import {relationalStore} from '@kit.ArkData';
import {ModelManifestV2} from 'scheduler';
export interface ImageRecord {hash:string;vector:number[];}
export interface ImageMatch {hash:string;score:number;}
export interface QueryResult {revision:number;matches:ImageMatch[];}
function space(m:ModelManifestV2):string{
 return JSON.stringify([m.modelId,m.version,m.weightsHash,m.preprocessVersion,m.embeddingKind,m.dimension,m.dtype,m.normalization]);
}
export class LocalImageIndex {
 private db:relationalStore.RdbStore;
 private constructor(db:relationalStore.RdbStore){this.db=db;}
 static async open(context:common.UIAbilityContext):Promise<LocalImageIndex>{
  const db=await relationalStore.getRdbStore(context,{name:'image-index-v2.db',securityLevel:relationalStore.SecurityLevel.S1});
  await db.executeSql('CREATE TABLE IF NOT EXISTS images(space TEXT NOT NULL, hash TEXT NOT NULL, vector TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(space,hash))');
  return new LocalImageIndex(db);
 }
 async append(model:ModelManifestV2,records:ImageRecord[]):Promise<number>{
  const key=space(model);
  this.db.beginTransaction();
  try{
   const rows=await this.db.querySql('SELECT COALESCE(MAX(revision),0) FROM images WHERE space=?',[key]);
   let revision=1;
   try{if(rows.goToFirstRow())revision=rows.getLong(0)+1;}finally{rows.close();}
   for(const record of records)await this.db.executeSql('INSERT OR REPLACE INTO images(space,hash,vector,revision) VALUES(?,?,?,?)',
     [key,record.hash,JSON.stringify(record.vector),revision]);
   this.db.commit();return revision;
  }catch(e){this.db.rollBack();throw e as Error;}
 }
 async query(model:ModelManifestV2,vector:number[]):Promise<QueryResult>{
  const rows=await this.db.querySql('SELECT hash,vector,revision FROM images WHERE space=?',[space(model)]);
  const matches:ImageMatch[]=[];let revision=0;
  try{while(rows.goToNextRow()){
   const other=JSON.parse(rows.getString(1)) as number[];
   if(other.length!==vector.length)throw Error('INDEX_VECTOR_DIMENSION');
   matches.push({hash:rows.getString(0),score:other.reduce((sum:number,x:number,i:number)=>sum+x*vector[i],0)});
   revision=Math.max(revision,rows.getLong(2));
  }}finally{rows.close();}
  matches.sort((a:ImageMatch,b:ImageMatch)=>b.score-a.score||a.hash.localeCompare(b.hash));
  return {revision,matches:matches.slice(0,10)};
 }
}
