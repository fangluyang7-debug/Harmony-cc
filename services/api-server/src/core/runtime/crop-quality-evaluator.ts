import { createHash, randomUUID } from 'node:crypto';
import sharp = require('sharp');
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { canonical, RuntimeCostStore } from './runtime-cost-store';

export interface CropQualityPolicy {
  evaluationId: string; fixtureSetHash: string; minimumPsnrDb: number; minimumCases: number; validForMs: number;
}
export interface CropQualityFixture { id: string; input: Buffer; parameters: Record<string, unknown>; }
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export function cropFixtureHash(fixtures: CropQualityFixture[]): string {
  return digest(canonical(fixtures.map(f=>({id:f.id,inputHash:digest(f.input),parameters:f.parameters})).sort((a,b)=>a.id.localeCompare(b.id))));
}
function policy(): CropQualityPolicy | undefined {
  if (!process.env.CROP_QUALITY_POLICY_JSON) return;
  const p=JSON.parse(process.env.CROP_QUALITY_POLICY_JSON) as CropQualityPolicy;
  if (!p.evaluationId || !/^[a-f0-9]{64}$/.test(p.fixtureSetHash) || !Number.isFinite(p.minimumPsnrDb) || p.minimumPsnrDb<=0 ||
      !Number.isSafeInteger(p.minimumCases)||p.minimumCases<3||p.minimumCases>5||
      !Number.isFinite(p.validForMs)||p.validForMs<=0||p.validForMs>7*86400000) throw new Error('CROP_QUALITY_POLICY_INVALID');
  return p;
}

/** Maintenance-only evaluator. Callbacks execute fixed fixtures, never replay shopping requests. */
export class CropQualityEvaluator {
  constructor(private readonly prisma?: PrismaService) {}
  async approved(deviceId:string, executorVersion:string):Promise<boolean> {
    const p=policy();
    if (!p||!this.prisma) return false;
    const row=await this.prisma.runtimeQualityEvidence.findFirst({where:{deviceId,executorVersion,policyHash:digest(canonical(p)),
      observedAt:{gt:new Date(Date.now()-p.validForMs),lte:new Date()}},orderBy:[{observedAt:'desc'},{passed:'asc'}]});
    return row?.passed===true;
  }
  async evaluate(deviceId:string,executorVersion:string,fixtures:CropQualityFixture[],
    reference:(fixture:CropQualityFixture)=>Promise<Buffer>,target:(fixture:CropQualityFixture)=>Promise<Buffer>,ownerId?:string) {
    const p=policy();
    if(!p||!this.prisma)throw new Error('CROP_QUALITY_NOT_CONFIGURED');
    if(fixtures.length<p.minimumCases||fixtures.length>5||new Set(fixtures.map(f=>f.id)).size!==fixtures.length||
        cropFixtureHash(fixtures)!==p.fixtureSetHash)throw new Error('CROP_QUALITY_FIXTURE_MISMATCH');
    const results:Array<{id:string;psnrDb:number|null;passed:boolean;error?:string}>=[];
    const run=async()=>{
    for(const fixture of fixtures) {
      try {
        const expected=await reference(fixture),actual=await target(fixture);
        const decode=(buffer:Buffer)=>sharp(buffer,{limitInputPixels:1024*1024}).toColourspace('srgb').removeAlpha().raw().toBuffer({resolveWithObject:true});
        const a=await decode(expected),b=await decode(actual);
        if(a.info.width!==b.info.width||a.info.height!==b.info.height||a.info.channels!==b.info.channels||a.data.length!==b.data.length)
          throw new Error('DIMENSIONS_DIFFER');
        let squared=0;
        for(let i=0;i<a.data.length;i++)squared+=(a.data[i]-b.data[i])**2;
        // null denotes pixel-identical output (infinite PSNR), not unknown evidence.
        const psnrDb=squared===0?null:10*Math.log10(255**2/(squared/a.data.length));
        results.push({id:fixture.id,psnrDb,passed:psnrDb===null||psnrDb>=p.minimumPsnrDb});
      }catch { results.push({id:fixture.id,psnrDb:null,passed:false,error:'REFERENCE_OR_TARGET_EVALUATION_FAILED'}); }
    }
    };
    if(ownerId)await RuntimeCostStore.shared(this.prisma).withQualityCalibration(ownerId,deviceId,fixtures.length,run);
    else await run();
    const passed=results.every(r=>r.passed);
    await this.prisma.runtimeQualityEvidence.create({data:{id:randomUUID(),deviceId,executorVersion,
      policyHash:digest(canonical(p)),passed,resultsJson:JSON.stringify(results),observedAt:new Date()}});
    return {evaluationId:p.evaluationId,passed,results};
  }
}
