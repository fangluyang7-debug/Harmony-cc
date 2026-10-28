import { PrismaService } from '../../persistence/prisma/prisma.service';

export interface CapabilityQualityEvaluator {
  approved(deviceId:string,executorVersion:string):Promise<boolean>;
}

/** Evaluators own their validation policy. Unregistered capabilities require an exact manual approval. */
export class CapabilityQualityRegistry {
  private readonly evaluators=new Map<string,CapabilityQualityEvaluator>();
  constructor(private readonly prisma?:PrismaService) {}
  register(capability:string,evaluator:CapabilityQualityEvaluator):void {
    if(this.evaluators.has(capability))throw new Error('QUALITY_EVALUATOR_ALREADY_REGISTERED');
    this.evaluators.set(capability,evaluator);
  }
  async approved(capability:string,deviceId:string,executorVersion:string):Promise<boolean> {
    const evaluator=this.evaluators.get(capability);
    if(evaluator)return evaluator.approved(deviceId,executorVersion);
    if(!this.prisma)return false;
    const row=await this.prisma.runtimeCapabilityApproval.findUnique({where:{capability_deviceId_executorVersion:{capability,deviceId,executorVersion}}});
    return row?.approved===true&&row.expiresAt.getTime()>Date.now()&&row.observedAt.getTime()<=Date.now();
  }
  // Maintenance API only: never exposed to a device's heartbeat or result submission.
  async setManualApproval(capability:string,deviceId:string,executorVersion:string,approved:boolean,
    reviewer:string,reason:string,expiresAt:Date):Promise<void> {
    if(!this.prisma||this.evaluators.has(capability))throw new Error('MANUAL_QUALITY_APPROVAL_UNAVAILABLE');
    if([capability,deviceId,executorVersion,reviewer,reason].some(v=>!v||v.length>512)||
      !Number.isFinite(expiresAt.getTime())||expiresAt.getTime()<=Date.now()||expiresAt.getTime()>Date.now()+30*86400000)
      throw new Error('QUALITY_APPROVAL_INVALID');
    const data={capability,deviceId,executorVersion,approved,reviewer,reason,expiresAt,observedAt:new Date()};
    await this.prisma.runtimeCapabilityApproval.upsert({where:{capability_deviceId_executorVersion:{capability,deviceId,executorVersion}},create:data,update:data});
  }
}
