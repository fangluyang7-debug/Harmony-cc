import { planJson, availabilityJson } from './generated/PlanningCore';
import { monotonic } from '../platform/NativeTransport';
/** Keep algorithm selection and scheduling costs identical to Windows main. */
export class CoordinatorPlanning {
 plan(snapshot:string,request:string,policy:string,now:number):string{return planJson(snapshot,request,policy,now,monotonic);}
 availability(profile:string,executor:string,priority:string,version:number,now:number):string{return availabilityJson(profile,executor,priority,version,now);}
}
