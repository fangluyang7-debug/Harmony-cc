const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),baseline=JSON.parse(fs.readFileSync(path.join(root,'docs/experiments/results/S4-core-baseline.json')));
const after=JSON.parse(fs.readFileSync(path.join(root,'docs/experiments/results/S4-core-after.json')));
assert.deepEqual(after.files,baseline.files,'S4 before/after core differs');
if(!process.argv.includes('--current')){console.log('PASS recorded S4 boundary: '+Object.keys(baseline.files).length+' core files unchanged');process.exit(0);}
const roots=['packages/scheduler-core/src','apps/harmony/scheduler/src/main/ets/v2/core','apps/harmony/scheduler/src/main/ets/v2/protocol'];
function walk(dir){return fs.readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(dir+'/'+e.name):[dir+'/'+e.name]);}
assert.deepEqual(roots.flatMap(walk).sort(),Object.keys(baseline.files).sort(),'S4 core file set changed');
assert.equal(fs.readFileSync(path.join(root,'apps/harmony-indexer/entry/src/main/ets/IndexerSession.ets'),'utf8'),fs.readFileSync(path.join(root,'apps/harmony/entry/src/main/ets/services/V2CropSession.ets'),'utf8'),'S4 acceptance controllers diverged');
for(const [file,expected]of Object.entries(baseline.files))assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex'),expected,'S4 core changed: '+file);
console.log('PASS S4 core baseline: '+Object.keys(baseline.files).length+' source files unchanged');
