const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const file='apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorSchema.ets';
test('native coordinator uses every Windows migration unchanged and SQLite can apply them',()=>{
 const text=fs.readFileSync(file,'utf8'),migrations=JSON.parse(text.slice(text.indexOf('[]=' )+3).trim().replace(/;$/,''));
 const source='services/coordinator/prisma/migrations',ids=fs.readdirSync(source).filter(id=>fs.existsSync(path.join(source,id,'migration.sql'))).sort();
 assert.deepEqual(migrations.map(m=>m.id),ids);
 for(const m of migrations)assert.equal(m.digest,crypto.createHash('sha256').update(fs.readFileSync(path.join(source,m.id,'migration.sql'))).digest('hex'));
 const program=`import sqlite3,json,sys\nm=json.load(sys.stdin)\ndb=sqlite3.connect(':memory:')\nfor migration in m:\n for sql in migration['statements']: db.execute(sql)\nfor table in ['CoordinatorState','Attempt','Outbox','RegisteredApp','RegisteredInstallation']:\n db.execute('SELECT * FROM '+table).fetchall()\nprint('schema ok')`;
 const result=spawnSync('python',['-c',program],{input:JSON.stringify(migrations),encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/schema ok/);
});
