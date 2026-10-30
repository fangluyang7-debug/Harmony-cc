import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { Body, Controller, Get, Headers, Param, Module, Post, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '../generated/client';
import { CoordinatorConfig, databaseUrl } from './config';
import { acquireProcessLock, loadIdentity } from './identity';
import { CoordinatorStore } from './store';
import { SnapshotBuilder, PlanningService } from './planning';
import { ControlChannel, Peer } from './channel';
import { PairingService } from './auth';
import { DeviceDirectory } from './directory';
import { ProfileProjection } from './profile-projection';
import { AllotmentIssuer } from './allotments';
import { TraceService } from './traces';
import { ArtifactChannel, ArtifactSchema } from '@harmony/resource-transport';
import { validDeviceProfileV2, validResourceVectorV2, validAllotmentAckV2, protocolId } from '@harmony/scheduler-core';

export async function createCoordinator(config:CoordinatorConfig, recover:(db:PrismaClient,epoch:number)=>Promise<void>=async()=>{},options:{authenticate?:(token:string)=>Promise<Peer>;artifactSchemas?:ReadonlyMap<string,ArtifactSchema>}={}){
  const unlock=await acquireProcessLock(config.dataDir);
  const db=new PrismaClient({datasources:{db:{url:databaseUrl(config)}}});
  let ready=false;
  try{
    await db.$connect();
    if(!fs.existsSync(path.join(config.dataDir,'identity.json'))&&await db.coordinatorState.count()>0)throw new Error('COORDINATOR_IDENTITY_LOST');
    const identity=loadIdentity(config);
    const store=new CoordinatorStore(db,identity.id);
    const auth=new PairingService(db,identity.cert,config.domain);
    const artifacts=new ArtifactChannel(path.join(config.dataDir,'artifact-cache'),config.domain,token=>auth.authenticate(token),options.artifactSchemas??new Map());
    artifacts.sweep();
    const directory=new DeviceDirectory(db,config.domain);
    const bearer=(value:string)=>{if(!value?.startsWith('Bearer '))throw new UnauthorizedException();return value.slice(7);};
    const snapshots=new SnapshotBuilder(db,config.domain),planning=new PlanningService(snapshots);
    const profiles=new ProfileProjection(db,directory,snapshots);
    const traces=new TraceService(db);
    @Controller('/v2/health')
    class Health {
      @Get('live')live(){return {live:true};}
      @Get('ready')readiness(){if(!ready)throw new ServiceUnavailableException('RECOVERY_PENDING');return {ready:true};}
    }
    @Controller('/v2')
    class Pairing {
      @Post('traces')async traceBatch(@Headers('authorization') header:string,@Body() body:any){
        if(!ready)throw new ServiceUnavailableException();try{if(!body||Object.keys(body).join('|')!=='spans')throw Error('TRACE_INVALID');
          await traces.ingest(await auth.authenticate(bearer(header)),body.spans);return {accepted:body.spans.length};}catch{throw new UnauthorizedException('TRACE_REJECTED');}
      }
      @Get('traces/:traceId')async trace(@Headers('authorization') header:string,@Param('traceId') traceId:string){
        if(!ready)throw new ServiceUnavailableException();try{return await traces.read(await auth.authenticate(bearer(header)),traceId);}catch{throw new UnauthorizedException('TRACE_REJECTED');}
      }
      @Post('pair')async pair(@Body() body:any){if(!ready)throw new ServiceUnavailableException();try{return {...await auth.exchange(body),epoch};}catch{throw new UnauthorizedException('PAIRING_REJECTED');}}
      @Post('credentials/rotate')async rotate(@Headers('authorization') header:string){try{return await auth.rotate(bearer(header));}catch{throw new UnauthorizedException('CREDENTIAL_REJECTED');}}
      @Post('credentials/revoke')async revoke(@Headers('authorization') header:string){try{const peer=await auth.authenticate(bearer(header));await auth.revoke(peer.credentialId);return {revoked:true};}catch{throw new UnauthorizedException('CREDENTIAL_REJECTED');}}
      @Get('identity')info(){if(!ready)throw new ServiceUnavailableException();return {version:2,coordinatorId:identity.id,epoch,domain:config.domain};}
      @Post('allotments/request')async grant(@Headers('authorization') header:string,@Body() body:any){
        if(!ready)throw new ServiceUnavailableException();
        try{
          const peer=await auth.authenticate(bearer(header));
          if(!body||Object.keys(body).sort().join('|')!=='base|extra|leaseMs|leaseRequestId|ledgerEpoch'||!validResourceVectorV2(body.base)||!validResourceVectorV2(body.extra)||!protocolId(body.leaseRequestId)||!Number.isSafeInteger(body.ledgerEpoch)||body.ledgerEpoch<1||!Number.isSafeInteger(body.leaseMs)||body.leaseMs<1||body.leaseMs>300000)throw Error('REQUEST_INVALID');
          return await allotments.issue(peer,body);
        }catch{throw new UnauthorizedException('ALLOTMENT_REJECTED');}
      }
      @Post('allotments/ack')async grantAck(@Headers('authorization') header:string,@Body() body:any){
        if(!ready)throw new ServiceUnavailableException();
        try{
          const peer=await auth.authenticate(bearer(header));
          if(!body||Object.keys(body).sort().join('|')!=='ack|signature'||!validAllotmentAckV2(body.ack)||typeof body.signature!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(body.signature))throw Error('ACK_INVALID');
          await allotments.acknowledge(peer,body.ack,body.signature);return {acknowledged:true};
        }catch{throw new UnauthorizedException('ALLOTMENT_ACK_REJECTED');}
      }
    }
    @Module({controllers:[Health,Pairing]})class AppModule{}
    const app=await NestFactory.create(AppModule,{logger:false,httpsOptions:{key:identity.key,cert:identity.cert},abortOnError:false});
    app.use((request:any,response:any,next:()=>void)=>{
      if(request.url.startsWith('/v2/artifacts/')){if(!ready){response.status(503).end();return;}void artifacts.handle(request,response);}
      else next();
    });
    await app.init();
    let epoch=0;
    const allotments=new AllotmentIssuer(db,identity.key,()=>epoch);
    const channel=new ControlChannel(app.getHttpServer(),db,store,()=>ready,()=>epoch,options.authenticate??(token=>auth.authenticate(token)));
    auth.onRevoked(id=>channel.revoke(id));
    channel.register('DeviceProfile',{validate:validDeviceProfileV2,handle:(peer,payload)=>profiles.ingest(peer,payload)});
    channel.register('TraceBatch',{validate:p=>p&&Object.keys(p).join('|')==='spans'&&Array.isArray(p.spans),handle:(peer,p)=>traces.ingest(peer,p.spans)});
    let restoration:Promise<void>|undefined;
    const restore=()=>restoration??(restoration=(async()=>{
      await db.$connect();
      const state=await db.coordinatorState.upsert({where:{id:identity.id},create:{id:identity.id,epoch:1},update:{epoch:{increment:1}}});epoch=state.epoch;
      await store.recover(epoch);await recover(db,epoch);ready=true;
    })());
    let closed=false;
    return {app,db,identity,store,snapshots,planning,channel,auth,directory,profiles,allotments,artifacts,traces,get epoch(){return epoch;},get ready(){return ready;},restore,
      close:async()=>{if(closed)return;closed=true;ready=false;try{await channel.close();await app.close();await db.$disconnect();}finally{await unlock();}}};
  }catch(error){await db.$disconnect();await unlock();throw error;}
}
