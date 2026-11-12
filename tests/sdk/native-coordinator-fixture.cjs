const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite'),{transformSync}=require('esbuild');
exports.fixture=()=>{
 const sql=new DatabaseSync(':memory:');const source=fs.readFileSync('apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorSchema.ets','utf8');
 const migrations=JSON.parse(source.slice(source.indexOf('[]=')+3).trim().replace(/;$/,''));for(const migration of migrations)for(const statement of migration.statements)sql.exec(statement);
 const transaction={executeSql:async(query,args=[])=>sql.prepare(query).run(...args),querySql:async(query,args=[])=>{const statement=sql.prepare(query);statement.setReturnArrays(true);const rows=statement.all(...args);let at=-1;return {goToFirstRow:()=>{at=0;return rows.length>0;},goToNextRow:()=>++at<rows.length,getString:i=>rows[at][i]??'',getLong:i=>rows[at][i],isColumnNull:i=>rows[at][i]===null,close(){}};}};
 let tail=Promise.resolve();const database={transaction:work=>{const run=tail.then(async()=>{sql.exec('BEGIN');try{await work(transaction);sql.exec('COMMIT');}catch(e){sql.exec('ROLLBACK');throw e;}});tail=run.catch(()=>{});return run;}};
 const cache=new Map();function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file).exports;const m={exports:{}};cache.set(file,m);new Function('require','module','exports',transformSync(fs.readFileSync(file,'utf8'),{loader:'ts',format:'cjs'}).code)(name=>{
  if(name==='@kit.ArkData'||name==='@kit.AbilityKit')return {};
  if(name.includes('NativeTransport'))return {monotonic:()=>performance.now(),hash:b=>crypto.createHash('sha256').update(b).digest('hex'),bytes:s=>Buffer.from(s)};
  if(name.includes('CryptoArchitecture'))return {cryptoFramework:{createRandom:()=>({generateRandomSync:n=>({data:crypto.randomBytes(n)})})}};
  if(name.includes('ArkTS'))return {util:{generateRandomUUID:()=>crypto.randomUUID(),Base64Helper:class{encodeToStringSync(b){return Buffer.from(b).toString('base64')}},TextDecoder:{create:()=>({decodeToString:b=>Buffer.from(b).toString()})}}};
  if(name.startsWith('.'))return load(path.resolve(path.dirname(file),name+'.ets'));throw Error('Unexpected import '+name);
 },m,m.exports);return m.exports;}
 function device(id,holder,space='g',user='p'){sql.prepare('INSERT INTO SpaceDevice (id,spaceId,userId,holderId,name,settingsJson,createdAt) VALUES (?,?,?,?,?,?,?)').run(id,space,user,holder,id,JSON.stringify({ownerMode:'dedicated',maxCpuThreads:12,maxMemoryBytes:1073741824,reserveMemoryBytes:134217728,capacityMode:'auto'}),Date.now());}
 return {sql,database,load,device};
};
