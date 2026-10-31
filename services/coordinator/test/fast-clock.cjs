// Reproduce a real distributed-device wall-clock skew without changing the OS clock.
const realNow=Date.now;
Date.now=()=>realNow()+2500;
