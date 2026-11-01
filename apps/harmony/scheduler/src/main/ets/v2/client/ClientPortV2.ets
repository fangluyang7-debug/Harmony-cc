import { TaskInstanceV2, ExecutionReceiptV2 } from '../protocol/SchedulingProtocolV2';
/** C3 supplies the authenticated SDK host. This boundary does not depend on agent code. */
export interface ClientSubmissionPortV2 {
 submit(task:TaskInstanceV2):Promise<string>;
 cancel(attemptId:string):Promise<void>;
 result(attemptId:string):Promise<ExecutionReceiptV2|null>;
}
