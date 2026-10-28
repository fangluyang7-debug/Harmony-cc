import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { PrismaService } from '../src/persistence/prisma/prisma.service';
import { CropQualityEvaluator, cropFixtureHash, CropQualityFixture } from '../src/core/runtime/crop-quality-evaluator';
import { DeviceDirectoryService } from '../src/core/runtime/device-directory.service';
import { DeviceDispatchService } from '../src/core/runtime/device-dispatch.service';
import { PhoneDispatchService } from '../src/modules/runtime/phone-dispatch.service';
import { StandardQueryImageContentAdapterService } from '../src/modules/sessions/application/standard-query-image-content-adapter.service';

type Parameters = ParametersOfCrop;
type ParametersOfCrop = {box:{x:number;y:number;width:number;height:number};paddingRatio:number;targetSize:number;jpegQuality:number};
interface Manifest {
  deviceId:string; ownerId:string; kind:'WORKER'|'PHONE'; executorVersion:string;
  fixtures:Array<{id:string;file:string;imageUrl?:string;parameters:Parameters}>;
}
async function main() {
  const filename=process.argv[2];
  if(!filename)throw new Error('USAGE: calibrate-crop-quality.ts <manifest.json> [--describe]');
  const manifest=JSON.parse(await readFile(filename,'utf8')) as Manifest;
  if(!manifest.deviceId||!manifest.ownerId||!manifest.executorVersion||!['WORKER','PHONE'].includes(manifest.kind)||
    !Array.isArray(manifest.fixtures)||manifest.fixtures.length<3||manifest.fixtures.length>5)throw new Error('CALIBRATION_MANIFEST_INVALID');
  const fixtures:CropQualityFixture[]=await Promise.all(manifest.fixtures.map(async f=>({id:f.id,
    input:await readFile(path.resolve(path.dirname(filename),f.file)),parameters:f.parameters})));
  if(process.argv.includes('--describe')){
    console.log(JSON.stringify({fixtureSetHash:cropFixtureHash(fixtures),cases:fixtures.length,executorVersion:manifest.executorVersion},null,2));return;
  }
  const db=new PrismaService();
  try {
    await db.$connect();
    const directory=new DeviceDirectoryService(db),dispatch=new DeviceDispatchService(undefined,undefined,directory,db);
    const phone=new PhoneDispatchService(db,directory),reference=new StandardQueryImageContentAdapterService();
    const result=await new CropQualityEvaluator(db).evaluate(manifest.deviceId,manifest.executorVersion,fixtures,
      async f=>(await reference.cropBuffer(f.input,{signedUrl:'',...(f.parameters as unknown as Parameters)})).buffer,
      async f=>{
        const p=f.parameters as unknown as Parameters,signal=AbortSignal.timeout(60000);
        if(manifest.kind==='WORKER')return (await dispatch.calibrate(manifest.deviceId,manifest.ownerId,f.input,p,signal,manifest.executorVersion)).buffer;
        const url=manifest.fixtures.find(item=>item.id===f.id)?.imageUrl;
        if(!url)throw new Error('PHONE_FIXTURE_URL_REQUIRED');
        return phone.calibrateCrop(manifest.ownerId,manifest.deviceId,url,f.input,p,signal,manifest.executorVersion);
      },manifest.ownerId);
    console.log(JSON.stringify(result,null,2));
    if(!result.passed)process.exitCode=1;
  }finally{await db.$disconnect();}
}
main().catch(()=>{console.error('CROP_QUALITY_CALIBRATION_FAILED: check manifest, configured policy, database migration and target availability.');process.exitCode=1;});
