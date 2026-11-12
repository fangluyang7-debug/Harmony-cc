/** One instance per authenticated socket. Only responses to probes on this socket count. */
export class ControlHeartbeat {
  private sequence=0;
  private outstanding:string[]=[];
  private nextAt=0;
  private interval=5000;
  private missed=0;
  private lastReply:number|null=null;
  private nonce:string;
  constructor(nonce:string){this.nonce=nonce;}
  tick(now:number,busy:boolean):string|null {
    const interval=busy?500:5000;
    if(interval<this.interval)this.nextAt=Math.min(this.nextAt,now+interval);
    this.interval=interval;
    if(now<this.nextAt)return null;
    if(this.outstanding.length)this.missed++;
    this.nextAt=now+interval;
    const probe=this.nonce+':'+(++this.sequence);
    this.outstanding.push(probe);if(this.outstanding.length>2)this.outstanding.shift();
    return probe;
  }
  reply(probe:string,now:number):boolean{
    const index=this.outstanding.indexOf(probe);if(index<0)return false;
    this.outstanding.splice(0,index+1);this.lastReply=now;this.missed=0;return true;
  }
  freshReport(now:number):void{
    this.outstanding=[];this.missed=0;this.lastReply=now;
  }
  get suspect():boolean{return this.missed>=2;}
  get expired():boolean{return this.missed>=3;}
  age(now:number):number|null{return this.lastReply===null?null:Math.max(0,now-this.lastReply);}
}
