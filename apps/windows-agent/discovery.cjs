// Address hints only: discovered servers do not establish certificate trust.
const dgram=require('node:dgram');
function discoverCenters(){return new Promise(resolve=>{
 const socket=dgram.createSocket('udp4'),found=new Set();let done=false;
 const finish=()=>{if(done)return;done=true;clearTimeout(timer);try{socket.close();}catch{}resolve([...found]);};
 const timer=setTimeout(finish,2000);socket.on('error',finish);
 socket.on('message',message=>{if(message.length>1024)return;try{const hint=JSON.parse(message);if(hint.version===1&&hint.service==='harmony-coordinator'&&/^https:\/\/[0-9.]+:[0-9]+$/.test(hint.address)&&found.size<16)found.add(hint.address);}catch{}});
 socket.bind(0,'0.0.0.0',()=>{socket.setBroadcast(true);socket.send('HARMONY_DISCOVER_V1\n',7444,'255.255.255.255',()=>{});});
});}
module.exports={discoverCenters};
