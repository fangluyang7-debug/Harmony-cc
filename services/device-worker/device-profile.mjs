import os from 'node:os';

// CPU deltas work on Windows as well as Unix; loadavg is not CPU utilization.
let previous = os.cpus();
export function deviceProfile(manager) {
  const current = os.cpus();
  let idle = 0, total = 0;
  current.forEach((cpu,i)=>{
    const old=previous[i]; if(!old)return;
    idle+=cpu.times.idle-old.times.idle;
    total+=Object.keys(cpu.times).reduce((sum,key)=>sum+cpu.times[key]-old.times[key],0);
  });
  previous=current;
  const leases=[...manager.leases.values()].filter(l=>!l.settled);
  return {version:1,source:'REAL',capabilities:['image.crop.v1','vector.normalize.v1'],availableBackends:['CPU'],
    availableSlots:Math.max(0,manager.slots-leases.length),
    availableMemoryMB:Math.max(0,Math.min(os.freemem(),manager.memoryBytes-leases.reduce((sum,l)=>sum+l.memoryBytes,0)))/(1024*1024),
    cpuUsage:total>0?Math.max(0,Math.min(100,100*(1-idle/total))):null,cpuCores:current.length||null,
    thermalLevel:'UNKNOWN',queueLength:0};
}

export function startHeartbeat(manager) {
  const base=process.env.RUNTIME_COORDINATOR_URL;
  if(!base)return;
  const url=new URL(base);
  if(url.username||url.password||url.search||url.hash||
    (url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))) throw new Error('COORDINATOR_URL_INVALID');
  let active=false;
  const send=async()=>{
    if(active)return;active=true;
    try {
      const response=await fetch(base.replace(/\/$/,'')+'/api/v1/runtime/device-directory/'+encodeURIComponent(process.env.WORKER_DEVICE_ID??'cpu-worker')+'/heartbeat',{
        method:'POST',redirect:'error',headers:{Authorization:'Bearer '+process.env.WORKER_TOKEN,'Content-Type':'application/json'},
        body:JSON.stringify(deviceProfile(manager)),signal:AbortSignal.timeout(4000)});
      if(!response.ok)console.error('DEVICE_HEARTBEAT_REJECTED',response.status);
    }catch {console.error('DEVICE_HEARTBEAT_UNAVAILABLE');}finally{active=false;}
  };
  void send();const timer=setInterval(()=>void send(),5000);timer.unref();
  return ()=>clearInterval(timer);
}
