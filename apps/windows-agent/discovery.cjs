// Address hints only: discovered servers do not establish certificate trust.
const dgram=require('node:dgram'),os=require('node:os');
function discoveryInterfaces(interfaces=os.networkInterfaces()){
 const found=new Map();
 for(const entries of Object.values(interfaces))for(const entry of entries||[]){
  if(entry.internal||!['IPv4',4].includes(entry.family))continue;
  const ip=entry.address.split('.').map(Number),mask=entry.netmask.split('.').map(Number);
  if(ip.length!==4||mask.length!==4||[...ip,...mask].some(n=>!Number.isInteger(n)||n<0||n>255)||mask.every(n=>n===255))continue;
  const broadcast=ip.map((n,i)=>(n|(~mask[i]&255))).join('.');found.set(entry.address,{address:entry.address,broadcast});
 }
 return [...found.values()].slice(0,32);
}
function discoverCenters(){return new Promise(resolve=>{
 const found=new Set(),sockets=[],retries=[];let done=false;
 const finish=()=>{if(done)return;done=true;clearTimeout(timer);for(const t of retries)clearTimeout(t);for(const socket of sockets)try{socket.close();}catch{}resolve([...found]);};
 const timer=setTimeout(finish,2000);
 const targets=discoveryInterfaces();if(!targets.length)targets.push({address:'0.0.0.0',broadcast:'255.255.255.255'});
 for(const target of targets){
  const socket=dgram.createSocket('udp4');sockets.push(socket);
  // One unavailable virtual NIC must not cancel discovery on the real WLAN.
  socket.on('error',()=>{try{socket.close();}catch{}});
  socket.on('message',message=>{if(done||message.length>1024)return;try{const hint=JSON.parse(message);if(hint.version===1&&hint.service==='harmony-coordinator'&&/^https:\/\/[0-9.]+:[0-9]+$/.test(hint.address)&&found.size<16)found.add(hint.address);}catch{}});
  socket.bind(0,target.address,()=>{if(done)return;try{socket.setBroadcast(true);const probe=()=>{if(!done)try{socket.send('HARMONY_DISCOVER_V1\n',7444,target.broadcast,()=>{});}catch{}};probe();for(const delay of [650,1300])retries.push(setTimeout(probe,delay));}catch{try{socket.close();}catch{}}});
 }
});}
module.exports={discoverCenters,discoveryInterfaces};
