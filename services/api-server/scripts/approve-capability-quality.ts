import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { PrismaService } from '../src/persistence/prisma/prisma.service';
import { createCapabilityQualityRegistry } from '../src/core/capabilities/quality-registry';

async function main() {
  if(!process.argv[2])throw new Error('USAGE: approve-capability-quality.ts <approval.json>');
  const value=JSON.parse(await readFile(process.argv[2],'utf8'));
  if(typeof value.approved!=='boolean'||['capability','deviceId','executorVersion','reviewer','reason','expiresAt'].some(k=>typeof value[k]!=='string'))
    throw new Error('QUALITY_APPROVAL_INVALID');
  const db=new PrismaService();
  try {
    await createCapabilityQualityRegistry(db).setManualApproval(value.capability,value.deviceId,value.executorVersion,
      value.approved,value.reviewer,value.reason,new Date(value.expiresAt));
    console.log('Capability quality decision saved.');
  }finally{await db.$disconnect();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'QUALITY_APPROVAL_FAILED');process.exitCode=1;});
