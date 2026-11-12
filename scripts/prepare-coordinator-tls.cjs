const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const version='3.6.7',digest='a7e8bcbec0e6f761b4af24f25677626b35f762f68eef79c08677a363212d11f6';
const directory=path.resolve(__dirname,'../.test/native-deps'),source=path.join(directory,'mbedtls-'+version),archive=path.join(directory,'mbedtls-'+version+'.tar.bz2');
async function prepare(){
 fs.mkdirSync(directory,{recursive:true});
 if(!fs.existsSync(archive)){const response=await fetch('https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-'+version+'/mbedtls-'+version+'.tar.bz2');if(!response.ok)throw Error('TLS_SOURCE_DOWNLOAD_FAILED');fs.writeFileSync(archive,Buffer.from(await response.arrayBuffer()));}
 if(crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')!==digest)throw Error('TLS_SOURCE_DIGEST_MISMATCH');
 if(!fs.existsSync(path.join(source,'library','ssl_tls.c')))execFileSync('tar',['-xf',archive,'-C',directory],{stdio:'inherit',windowsHide:true});
 console.log('Verified Mbed TLS '+version+' source: '+source);
}
if(require.main===module)prepare().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={source};
