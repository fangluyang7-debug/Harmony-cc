/**
 * Decides when the coordinator is gone for good: it said so (close code 4001), or it stayed
 * provably unreachable for 20 s. The desktop runtime then retires the pairing so the device
 * returns to the pairing screen instead of retrying a stopped coordinator forever.
 */
const UNREACHABLE=['ECONNREFUSED','EHOSTUNREACH','ENETUNREACH','ENOTFOUND','EADDRNOTAVAIL'];
export class CoordinatorGoneDetector {
  private since=-1;private last=-1;
  constructor(private readonly windowMs=20000,private readonly gapMs=8000){}
  observe(error:unknown,now:number):boolean{
    if(error instanceof Error&&error.message.startsWith('CHANNEL_CLOSED_4001'))return true;
    const code=(error as NodeJS.ErrnoException)?.code;
    if(typeof code!=='string'||!UNREACHABLE.includes(code))return false;
    // A gap longer than a few ticks means the coordinator answered in between: restart the window.
    if(this.since<0||now-this.last>this.gapMs)this.since=now;
    this.last=now;return now-this.since>=this.windowMs;
  }
}
