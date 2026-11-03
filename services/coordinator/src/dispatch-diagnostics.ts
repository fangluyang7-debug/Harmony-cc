/** Bounded process-local diagnostics. Callers supply identifiers and measurements only. */
export interface DispatchDiagnostic {
  at:number;kind:string;groupId:string;holderId?:string;jobId?:string;version?:number;
  stage?:string;retries?:number;code?:string;durationMs?:number;remainingMs?:number;offerVersion?:number;ackVersion?:number;
  snapshotVersion?:number;source?:string;
}
export class DispatchDiagnostics {
  private rows:DispatchDiagnostic[]=[];
  record(row:DispatchDiagnostic){this.rows=this.rows.filter(r=>r.at+300000>row.at);this.rows.push({...row});if(this.rows.length>512)this.rows.splice(0,this.rows.length-512);}
  recent(groupId:string){const now=Date.now();return this.rows.filter(r=>r.groupId===groupId&&r.at+300000>now).map(r=>({...r}));}
}
export const dispatchDiagnostics=new DispatchDiagnostics();
