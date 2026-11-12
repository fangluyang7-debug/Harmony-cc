import {serializeSqliteTransactions} from './sqlite-transactions';
import {DisplaySessions} from './display-sessions';
import {retryableJobError} from './job-errors';
import {WorkflowJobs} from './workflow-jobs';
import {ArtifactRetention} from './retention';
import {DirectTransfers} from './direct-transfers';
import { SpaceEvents } from './space-events';
import 'reflect-metadata';
import fs from 'node:fs';
import {X509Certificate} from 'node:crypto';
import path from 'node:path';
import { BadRequestException, ConflictException, Body, Req, Controller, Get, Header, Headers, Param, Module, Post, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
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
import { QualificationService, TrustedPack, EvaluationRunner, EvaluationPolicy } from './qualification';
import { QualificationLoop } from './qualification-loop';
import { RemoteEvaluationRunner } from './remote-evaluation';
import { ReferencePack, builtinCpuPacks, builtinReferencePacks, cpuSchemas } from '@harmony/reference-capabilities';
import { CpuJobs } from './cpu-jobs';
import { TeamSpaces, measuredCapacity } from './spaces';
import {TelemetryView} from './telemetry-view';
import { AppRegistry } from './apps';
import { SdkJobs } from './sdk';
import type { DeviceProfileV2,ExecutorV2 } from '@harmony/scheduler-core';
import { ArtifactChannel, ArtifactSchema,createSignedDataHandler,DataEndpointIdentity } from '@harmony/resource-transport';
import { canonical,validDeviceProfileV2, validResourceVectorV2, validAllotmentAckV2, protocolId } from '@harmony/scheduler-core';

export async function createCoordinator(config:CoordinatorConfig, recover:(db:PrismaClient,epoch:number)=>Promise<void>=async()=>{},options:{onError?:(error:unknown)=>void;authenticate?:(token:string)=>Promise<Peer>;artifactSchemas?:ReadonlyMap<string,ArtifactSchema>;cpuHost?:boolean;referencePacks?:ReferencePack[]}={}){
  const unlock=await acquireProcessLock(config.dataDir);
  const db=serializeSqliteTransactions(new PrismaClient({datasources:{db:{url:databaseUrl(config)}}}));
  let ready=false;
  try{
    await db.$connect();
    // The local coordinator writes profiles, outbox and receipts concurrently.
    // WAL avoids rollback-journal churn while FULL retains durable commits.
    const journal=await db.$queryRawUnsafe<{journal_mode:string}[]>('PRAGMA journal_mode=WAL');
    if(journal[0]?.journal_mode!=='wal')throw Error('COORDINATOR_WAL_UNAVAILABLE');
    await db.$executeRawUnsafe('PRAGMA synchronous=FULL');
    if(!fs.existsSync(path.join(config.dataDir,'identity.json'))&&await db.coordinatorState.count()>0)throw new Error('COORDINATOR_IDENTITY_LOST');
    const identity=loadIdentity(config);
    const referencePacks=options.referencePacks??(options.cpuHost?await builtinReferencePacks():builtinCpuPacks());
    const store=new CoordinatorStore(db,identity.id);
    const events=new SpaceEvents();
    const auth=new PairingService(db,identity.cert,config.domain);
    const display=new DisplaySessions(db);
    const apps=new AppRegistry(db,auth,identity.cert,config.domain);
    const artifacts=new ArtifactChannel(path.join(config.dataDir,'artifact-cache'),config.domain,token=>auth.authenticate(token),options.artifactSchemas??(options.cpuHost?cpuSchemas:new Map()));
    artifacts.sweep();
    const directTransfers=new DirectTransfers(db,identity.key,identity.cert,config.domain,()=>epoch);
    const directory=new DeviceDirectory(db,config.domain,Date.now,(tx,groupId)=>directTransfers.links(tx,groupId),(tx,groupId)=>directTransfers.list({groupId},tx));
    const bearer=(value:string)=>{if(!value?.startsWith('Bearer '))throw new UnauthorizedException();return value.slice(7);};
    const snapshots=new SnapshotBuilder(db,config.domain),planning=new PlanningService(snapshots);
    const profiles=new ProfileProjection(db,directory,snapshots);
    const refreshNetwork=async(groupId:string)=>{const row=await db.group.findUnique({where:{id:groupId}});if(row&&JSON.parse(row.metadataJson).contributionPolicy)await profiles.refresh(groupId,"NETWORK");events.changed(groupId);};
    const traces=new TraceService(db);
    const remoteEvaluation=new RemoteEvaluationRunner(db,directory,()=>epoch);
    @Controller('/v2/health')
    class Health {
      @Get('live')live(){return {live:true};}
      @Get('ready')readiness(){if(!ready)throw new ServiceUnavailableException('RECOVERY_PENDING');return {ready:true};}
    }
    @Controller('/v2')
    class Pairing {
      @Post('apps/photo')async appPhoto(@Headers('authorization') header:string,@Body() body:any){return this.jobResponse(async()=>spaces.appPhoto(await auth.authenticate(bearer(header)),body));}
      @Post('display')async inviteDisplay(@Headers('authorization') header:string,@Body() body:any){return this.jobResponse(async()=>display.invite(await auth.authenticate(bearer(header)),body));}
      @Get('display')async displayInbox(@Headers('authorization') header:string){return this.jobResponse(async()=>display.inbox(await auth.authenticate(bearer(header))));}
      @Get('display/:id')async displayStatus(@Headers('authorization') header:string,@Param('id') id:string){return this.jobResponse(async()=>display.status(await auth.authenticate(bearer(header)),id));}
      @Post('display/:id/:action')async displayChange(@Headers('authorization') header:string,@Param('id') id:string,@Param('action') action:string,@Body() body:any){return this.jobResponse(async()=>display.change(await auth.authenticate(bearer(header)),id,action,body));}
      @Post('data/endpoints/challenge')async endpointChallenge(@Headers('authorization') header:string,@Body() body:any){return this.jobResponse(async()=>directTransfers.challenge(await auth.authenticate(bearer(header)),body));}
      @Post('data/endpoints/register')async endpointRegister(@Headers('authorization') header:string,@Body() body:any){return this.jobResponse(async()=>{const peer=await auth.authenticate(bearer(header)),result=await directTransfers.register(peer,body);await refreshNetwork(peer.groupId);return result;});}
      @Get('data/endpoints')async endpoints(@Headers('authorization') header:string){return this.jobResponse(async()=>directTransfers.list(await auth.authenticate(bearer(header))));}
      @Post('data/deliveries/missing')async deliveryMissing(@Headers('authorization') header:string,@Body() body:any){return this.jobResponse(async()=>directTransfers.deliveryMissing(await auth.authenticate(bearer(header)),body));}
      @Post('data/rejections')async transferRejected(@Headers('authorization') header:string,@Body() body:any){return this.jobResponse(async()=>directTransfers.transferRejected(await auth.authenticate(bearer(header)),body));}
      @Post('data/missing')async readMissing(@Headers('authorization') header:string,@Body() body:any){return this.jobResponse(async()=>directTransfers.readMissing(await auth.authenticate(bearer(header)),body));}
      @Post('data/deliveries/failed')async deliveryFailed(@Headers('authorization') header:string,@Body() body:any){return this.jobResponse(async()=>directTransfers.deliveryFailed(await auth.authenticate(bearer(header)),body));}
      @Post('data/cache/inventory')async cacheInventory(@Headers('authorization') header:string,@Body() body:any){return this.jobResponse(async()=>retention.inventory(await auth.authenticate(bearer(header)),body));}
      @Get('data/retention')async retentionPlan(@Headers('authorization') header:string){return this.jobResponse(async()=>retention.plan(await auth.authenticate(bearer(header))));}
      @Post('data/releases')async releaseConfirmed(@Headers('authorization') header:string,@Body() body:any){return this.jobResponse(async()=>retention.confirm(await auth.authenticate(bearer(header)),body));}
      @Get('data/deliveries')async pendingDeliveries(@Headers('authorization') header:string){return this.jobResponse(async()=>directTransfers.pendingDeliveries(await auth.authenticate(bearer(header))));}
      @Post('data/authorizations')async transferAuthorization(@Headers('authorization') header:string,@Body() body:any){return this.jobResponse(async()=>directTransfers.issue(await auth.authenticate(bearer(header)),body));}
      @Post('data/consume')async transferConsume(@Headers('authorization') header:string,@Body() body:any){return this.jobResponse(async()=>directTransfers.consume(await auth.authenticate(bearer(header)),body));}
      @Post('data/observations')async transferObservation(@Headers('authorization') header:string,@Body() body:any){return this.jobResponse(async()=>{const peer=await auth.authenticate(bearer(header)),result=await directTransfers.observe(peer,body);if(result.recorded)await refreshNetwork(peer.groupId);return result;});}
      @Post('data/receipts')async transferReceipt(@Headers('authorization') header:string,@Body() body:any){return this.jobResponse(async()=>directTransfers.receipt(await auth.authenticate(bearer(header)),body));}
      @Post('data/traces')async transferTrace(@Headers('authorization') header:string,@Body() body:any){return this.jobResponse(async()=>traces.transfer(await auth.authenticate(bearer(header)),body));}
      @Post('data/network/reset')async networkReset(@Headers('authorization') header:string){return this.jobResponse(async()=>{const peer=await auth.authenticate(bearer(header)),result=await directTransfers.resetNetwork(peer);await refreshNetwork(peer.groupId);return result;});}
      @Post('data/network/report')async networkReport(@Headers('authorization') header:string,@Body() body:any){return this.jobResponse(async()=>{const peer=await auth.authenticate(bearer(header)),result=await directTransfers.reportLink(peer,body);await refreshNetwork(peer.groupId);return result;});}
      @Get('data/network')async networkStatus(@Headers('authorization') header:string){return this.jobResponse(async()=>directTransfers.network(await auth.authenticate(bearer(header))));}
      @Post('data/network/failure')async networkFailure(@Headers('authorization') header:string,@Body() body:any){return this.jobResponse(async()=>{const peer=await auth.authenticate(bearer(header)),result=await directTransfers.failedLink(peer,body);await refreshNetwork(peer.groupId);return result;});}
      @Post('link-probe')async probe(@Headers('authorization') header:string,@Body() body:any){
        try{await auth.authenticate(bearer(header));}catch{throw new UnauthorizedException('CREDENTIAL_REJECTED');}
        if(!body||!['upload','download'].includes(body.mode)||!Number.isSafeInteger(body.bytes)||body.bytes<1||body.bytes>32768||
          Object.keys(body).some(k=>!['mode','bytes','padding'].includes(k))||
          (body.mode==='upload'?(typeof body.padding!=='string'||body.padding.length!==body.bytes||!/^[x]+$/.test(body.padding)):body.padding!==undefined))throw new BadRequestException('PROBE_INVALID');
        return {relayId:identity.id,padding:body.mode==='download'?'x'.repeat(body.bytes):''};
      }
      @Post('device-settings')async deviceSettings(@Headers('authorization') header:string,@Body() body:any){
        return this.jobResponse(async()=>{const peer=await auth.authenticate(bearer(header));const measured=body&&typeof body==='object'&&body.measured!==undefined?measuredCapacity(body.measured):undefined;return {settings:await spaces.deviceSettings(peer,measured)};});
      }
      private async jobResponse(work:()=>Promise<unknown>){if(!ready)throw new ServiceUnavailableException('RECOVERY_PENDING');try{return await work();}catch(error){options.onError?.(error);const code=error instanceof Error&&/^[A-Z][A-Z0-9_]{0,99}$/.test(error.message)?error.message:'JOB_FAILED';if(error instanceof UnauthorizedException||code.startsWith('CREDENTIAL_'))throw new UnauthorizedException(code);if(retryableJobError(code))throw new ConflictException({message:code,error:code,retryable:true});throw new BadRequestException({message:code,error:code,retryable:false});}}
      @Get('devices')@Header('Cache-Control','no-store')async devices(@Headers('authorization') header:string){
        return this.jobResponse(async()=>{const peer=await auth.authenticate(bearer(header));return {profiles:await directory.profiles(peer.groupId)};});
      }
      @Post('jobs')async submitJob(@Headers('authorization') header:string,@Body() body:any){
        if(!ready||!options.cpuHost)throw new ServiceUnavailableException('CPU_HOST_DISABLED');
        return this.jobResponse(async()=>jobs.submit(await auth.authenticate(bearer(header)),body));
      }
      @Post('sdk/jobs')async sdkSubmit(@Headers('authorization') header:string,@Body() body:any){
        if(!ready||!options.cpuHost)throw new ServiceUnavailableException('CPU_HOST_DISABLED');return this.jobResponse(async()=>sdk.submit(await auth.authenticate(bearer(header)),body));
      }
      @Post('sdk/jobs/:id/start')async sdkStart(@Headers('authorization') header:string,@Param('id') id:string){
        if(!ready||!options.cpuHost)throw new ServiceUnavailableException('CPU_HOST_DISABLED');return this.jobResponse(async()=>sdk.start(await auth.authenticate(bearer(header)),id));
      }
      @Get('sdk/jobs/:id')@Header('Cache-Control','no-store')async sdkStatus(@Headers('authorization') header:string,@Param('id') id:string){
        if(!ready||!options.cpuHost)throw new ServiceUnavailableException('CPU_HOST_DISABLED');return this.jobResponse(async()=>sdk.status(await auth.authenticate(bearer(header)),id));
      }
      @Post('sdk/jobs/:id/received')async resultReceived(@Headers('authorization') header:string,@Param('id') id:string,@Body() body:any){return this.jobResponse(async()=>sdk.received(await auth.authenticate(bearer(header)),id,body));}
      @Post('sdk/jobs/:id/cancel')async sdkCancel(@Headers('authorization') header:string,@Param('id') id:string){
        if(!ready||!options.cpuHost)throw new ServiceUnavailableException('CPU_HOST_DISABLED');return this.jobResponse(async()=>sdk.cancel(await auth.authenticate(bearer(header)),id));
      }
      @Post('jobs/:id/start')async startJob(@Headers('authorization') header:string,@Param('id') id:string){
        if(!ready||!options.cpuHost)throw new ServiceUnavailableException('CPU_HOST_DISABLED');return this.jobResponse(async()=>jobs.start(await auth.authenticate(bearer(header)),id));
      }
      @Get('jobs/:id')@Header('Cache-Control','no-store')async job(@Headers('authorization') header:string,@Param('id') id:string){
        if(!ready||!options.cpuHost)throw new ServiceUnavailableException('CPU_HOST_DISABLED');return this.jobResponse(async()=>jobs.status(await auth.authenticate(bearer(header)),id));
      }
      @Post('executions/:id/:action')async execution(@Headers('authorization') header:string,@Param('id') id:string,@Param('action') action:string,@Body() body:any){
        if(!ready||!options.cpuHost)throw new ServiceUnavailableException('CPU_HOST_DISABLED');return this.jobResponse(async()=>jobs.execution(await auth.authenticate(bearer(header)),id,action,body));
      }
      @Post('evaluations/claim')@Header('Cache-Control','no-store')async evaluationClaim(@Headers('authorization') header:string,@Body() body:any){
        if(!ready)throw new ServiceUnavailableException();
        try{if(!body||Object.keys(body).length)throw Error('EVALUATION_REQUEST');return {work:await remoteEvaluation.claim(await auth.authenticate(bearer(header)))};}
        catch{throw new UnauthorizedException('EVALUATION_REJECTED');}
      }
      @Get('evaluations/:id')@Header('Cache-Control','no-store')async evaluationStatus(@Headers('authorization') header:string,@Param('id') id:string){
        if(!ready)throw new ServiceUnavailableException();
        try{if(!protocolId(id))throw Error('EVALUATION_ID');return await remoteEvaluation.status(await auth.authenticate(bearer(header)),id);}
        catch{throw new UnauthorizedException('EVALUATION_REJECTED');}
      }
      @Post('evaluations/:id/report')async evaluationReport(@Headers('authorization') header:string,@Param('id') id:string,@Body() body:any){
        if(!ready)throw new ServiceUnavailableException();
        try{if(!protocolId(id))throw Error('EVALUATION_ID');return await remoteEvaluation.report(await auth.authenticate(bearer(header)),id,body);}
        catch{throw new UnauthorizedException('EVALUATION_REJECTED');}
      }
      @Get('qualification/:targetId')@Header('Cache-Control','no-store')async qualification(@Headers('authorization') header:string,@Param('targetId') targetId:string){
        if(!ready)throw new ServiceUnavailableException();
        try{if(!protocolId(targetId))throw Error('TARGET_INVALID');return await directory.qualification(await auth.authenticate(bearer(header)),targetId);}
        catch{throw new UnauthorizedException('QUALIFICATION_REJECTED');}
      }
      @Post('traces')async traceBatch(@Headers('authorization') header:string,@Body() body:any){
        if(!ready)throw new ServiceUnavailableException();try{if(!body||Object.keys(body).join('|')!=='spans')throw Error('TRACE_INVALID');
          await traces.ingest(await auth.authenticate(bearer(header)),body.spans);return {accepted:body.spans.length};}catch{throw new UnauthorizedException('TRACE_REJECTED');}
      }
      @Get('traces/:traceId')async trace(@Headers('authorization') header:string,@Param('traceId') traceId:string){
        if(!ready)throw new ServiceUnavailableException();try{return await traces.read(await auth.authenticate(bearer(header)),traceId);}catch{throw new UnauthorizedException('TRACE_REJECTED');}
      }
      @Get('pairing/certificate')@Header('Content-Type','application/x-pem-file')@Header('Cache-Control','no-store')
      pairingCertificate(){
        if(!ready||config.proxy||!config.publicUrl)throw new ServiceUnavailableException();
        return identity.cert;
      }
      @Post('pairing/bootstrap')@Header('Cache-Control','no-store')
      async pairingBootstrap(@Body() body:any){
        if(!ready||config.proxy||!config.publicUrl)throw new ServiceUnavailableException();
        try{return await auth.readDeviceInvite(body,config.publicUrl);}catch{throw new UnauthorizedException('PAIRING_REJECTED');}
      }
      @Post('pairing/code')@Header('Cache-Control','no-store')
      async pairingCode(@Body() body:any,@Req() request:any){
        if(!ready||config.proxy||!config.publicUrl)throw new ServiceUnavailableException();
        try{return await auth.redeemPairingCode(body?.code,config.publicUrl,request.socket.remoteAddress??'unknown');}
        catch{throw new UnauthorizedException('配对码无效、已使用或尝试过于频繁，请重新生成或稍后重试');}
      }
      @Post('pair')async pair(@Body() body:any){if(!ready)throw new ServiceUnavailableException();try{return {...await auth.exchange(body),epoch};}catch(error){if((error as Error).message==='SPACE_SWITCH_BUSY')throw new ConflictException('SPACE_SWITCH_BUSY');throw new UnauthorizedException('PAIRING_REJECTED');}}
      @Post('apps/registrations')async registerApp(@Headers('authorization') header:string,@Body() body:any){return this.jobResponse(async()=>apps.registerDeclaration(await auth.authenticate(bearer(header)),body,config.publicUrl??'https://'+config.certificateHost+':'+app.getHttpServer().address().port));}
      @Post('apps/exchange')async exchangeApp(@Body() body:any){return this.jobResponse(async()=>apps.exchange(body));}
      @Post('apps/me/performance')async appPerformance(@Headers('authorization') header:string){return this.jobResponse(async()=>apps.performance(await auth.authenticate(bearer(header))));}
      @Get('apps/me')async appIdentity(@Headers('authorization') header:string){return this.jobResponse(async()=>{const peer=await auth.authenticate(bearer(header)),context=await apps.context(peer),budget=await db.device.findUnique({where:{id:JSON.stringify(['budget',peer.deviceId])}});return {...context,deviceCapacity:budget?JSON.parse(budget.metadataJson).capacity:[]};});}
      /** Qualified-target counts per allowed contract. A count is a registration fact for the App's own routing report; the planner still chooses. */
      @Get('apps/me/capabilities')async appCapabilities(@Headers('authorization') header:string){return this.jobResponse(async()=>{const peer=await auth.authenticate(bearer(header)),context=await apps.context(peer);
        return {capabilities:await planning.availability(peer.groupId,context.identity.allowedContracts)};});}
      @Get('apps/registrations')async listApps(@Headers('authorization') header:string){return this.jobResponse(async()=>apps.list(await auth.authenticate(bearer(header))));}
      @Post('apps/registrations/:id/revoke')async revokeApp(@Headers('authorization') header:string,@Param('id') id:string){return this.jobResponse(async()=>apps.revoke(await auth.authenticate(bearer(header)),id));}
      @Post('credentials/rotate')async rotate(@Headers('authorization') header:string){try{return await auth.rotate(bearer(header));}catch{throw new UnauthorizedException('CREDENTIAL_REJECTED');}}
      @Post('devices/leave')async leaveDevice(@Headers('authorization') header:string){return this.jobResponse(async()=>auth.leaveDevice(await auth.authenticate(bearer(header))));}
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
    const app=await NestFactory.create(AppModule,{logger:false,...(config.proxy?{}:{httpsOptions:{key:identity.key,cert:identity.cert}}),abortOnError:false});
    const express=require('express');
    app.use('/v2/apps/photo',express.json({limit:'12mb'}));
    app.use(express.json({limit:'1mb'}));
    app.use('/v2/spaces',express.raw({type:'application/octet-stream',limit:'8mb'}));
    app.use('/v2/spaces',(req:any,res:any)=>{void spaces.handle(req,res);});
    if(config.webDir)app.use(express.static(path.resolve(config.webDir),{index:'index.html',maxAge:0}));
    app.use((request:any,response:any,next:()=>void)=>{
      if(request.url.startsWith('/v2/direct/')){if(!ready||!relayData){response.status(503).end();return;}relayData.handle(request,response);}
      else if(request.url.startsWith('/v2/artifacts/')){if(!ready){response.status(503).end();return;}void artifacts.handle(request,response);}
      else next();
    });
    await app.init();
    let epoch=0;
    const relayEndpoint=(groupId=''):DataEndpointIdentity=>({id:identity.id,groupId,holderInstanceId:identity.id,deviceId:identity.id,epoch:String(epoch),
      address:config.publicUrl??'https://'+(config.certificateHost.includes(':')?'['+config.certificateHost+']':config.certificateHost)+':'+app.getHttpServer().address().port,
      certificate:identity.cert,fingerprint:new X509Certificate(identity.cert).fingerprint256.replaceAll(':','').toLowerCase()});
    // Proxy TLS uses a different certificate; signed relay is enabled on LAN TLS only.
    const relayData=config.proxy?null:createSignedDataHandler({directory:path.join(config.dataDir,'artifact-cache'),domain:config.domain,key:identity.key,certificate:identity.cert,
      coordinatorCertificate:identity.cert,endpoint:groupId=>groupId?relayEndpoint(groupId):null,channel:artifacts,schemas:options.artifactSchemas??(options.cpuHost?cpuSchemas:new Map()),
      consume:(signed,proof)=>directTransfers.relayConsume(signed,proof),receipt:(id,hash,bytes)=>directTransfers.relayReceipt(id,hash,bytes),onRejected:(id,code)=>directTransfers.relayRejected(id,code),onReceived:async(signed,start,end)=>{
        const row=await db.cpuJob.findUniqueOrThrow({where:{id:signed.authorization.attemptId}}),d=JSON.parse(row.metadataJson);
        await traces.transfer({groupId:signed.authorization.groupId,deviceId:identity.id,holderInstanceId:identity.id,principalId:identity.id,credentialId:identity.id},
          {authorizationId:signed.authorization.id,side:'RECEIVER',interval:{clockDomainId:traces.clockDomainId,startMono:start,endMono:end}});
      }});
    if(relayData)directTransfers.configureRelay({endpoint:relayEndpoint,available:d=>artifacts.available(d),slots:()=>artifacts.availableTransferSlots,bytes:()=>artifacts.availableCacheBytes});
    const allotments=new AllotmentIssuer(db,identity.key,()=>epoch);
    const channel=new ControlChannel(app.getHttpServer(),db,store,()=>ready,()=>epoch,options.authenticate??(token=>auth.authenticate(token)),undefined,groupId=>{events.changed(groupId);graphs.changed(groupId);jobs.batch.changed(groupId);},error=>options.onError?.(error));
    channel.onSettlement=peer=>profiles.changed(peer.groupId,peer.holderInstanceId);
    directory.controlState=(group,holder,instance,epoch)=>channel.linkState(group,holder,instance,epoch);
    const retention=new ArtifactRetention(db,directTransfers,artifacts);
    const jobs=new CpuJobs(db,directory,profiles,snapshots,allotments,artifacts,store,()=>epoch,()=>channel.flush(),planning,traces,apps,referencePacks,directTransfers),graphs=new WorkflowJobs(db,jobs,apps,artifacts,referencePacks,retention),sdk=new SdkJobs(jobs,referencePacks,graphs,retention);
    channel.onUnstarted=(tx,id)=>graphs.adoptUnstarted(tx,id);
    channel.onUnavailable=peer=>jobs.unavailable(peer);
    const telemetry=new TelemetryView(db,directory,traces,groupId=>directTransfers.dashboard(groupId));
    const spaces=new TeamSpaces(db,auth,allotments,directory,jobs,artifacts,config,()=>({ready,epoch}),snapshots,events,apps,sdk,groupId=>directTransfers.dashboard(groupId),telemetry);
    remoteEvaluation.onChanged((groupId,holderInstanceId)=>{void channel.evaluationChanged(groupId,holderInstanceId).catch(()=>{});});
    auth.onRevoked(id=>channel.revoke(id));
    const configureCpuGroup=async(groupId:string,alreadyProjected=false)=>{
      const existing=await db.group.findUnique({where:{id:groupId}});
      const saved=existing&&JSON.parse(existing.metadataJson);
      if(saved&&saved.policy?.version!=='cpu-host-v1'){if(!alreadyProjected&&saved.contributionPolicy)await profiles.refresh(groupId);return;}
      const packs=referencePacks,targets=(await directory.profiles(groupId)).flatMap(p=>p.executors.filter(e=>packs.some(pack=>pack.manifest.contract.capability===e.contract.capability)).map(e=>e.target.targetId));
      const policy={version:'cpu-host-v1',revoked:false,allowedTargetIds:targets.sort(),limits:{maxCandidates:64,lookahead:16,beamWidth:8,planningBudgetMs:20,switchCostMs:0,hysteresisMs:0}};
      const contribution={minimumBattery:null,maximumTemperature:null,allowMetered:true,priority:'REMOTE_INTERACTIVE' as const,requireForeground:true};
      if(alreadyProjected&&saved&&canonical(saved.policy)===canonical(policy)&&canonical(saved.contributionPolicy)===canonical(contribution))return;
      await profiles.configure(groupId,policy,contribution,'cpu-host-v1');
    };
    channel.register('DeviceProfile',{validate:validDeviceProfileV2,handle:async(peer,payload)=>{await profiles.ingest(peer,payload);if(options.cpuHost)await configureCpuGroup(peer.groupId,true);if(payload.inFlight?.some((f:{history?:unknown})=>f.history))await jobs.assessSlow(peer.groupId,payload).catch(error=>options.onError?.(error));}});
    channel.register('TraceBatch',{validate:p=>p&&Object.keys(p).join('|')==='spans'&&Array.isArray(p.spans),handle:(peer,p)=>traces.ingest(peer,p.spans)});
    let restoration:Promise<void>|undefined;
    const restore=()=>restoration??(restoration=(async()=>{
      await db.$connect();
      const state=await db.coordinatorState.upsert({where:{id:identity.id},create:{id:identity.id,epoch:1},update:{epoch:{increment:1}}});epoch=state.epoch;
      await store.recover(epoch);await recover(db,epoch);ready=true;retention.start();await jobs.batch.restore();
      if(options.cpuHost){
        for(const groupId of new Set((await auth.activePeers()).map(p=>p.groupId)))await configureCpuGroup(groupId);
        const maxRuns=Math.max(8,...referencePacks.map(pack=>pack.cases.length+2)),caseTimeoutMs=15000;
        const maxBytes=Math.max(16777216,...referencePacks.map(pack=>pack.cases.reduce((sum,c)=>sum+c.input.length+c.maxOutputBytes,0)));
        startCalibration({packs:referencePacks,policy:{maxRuns,maxDurationMs:maxRuns*caseTimeoutMs,maxBytes,maxConcurrent:4,caseTimeoutMs,canarySamples:1,activeSamples:2,evidenceTtlMs:3600000,cooldownMs:5000},
          gate:async()=>null,onError:()=>{},intervalMs:1000});
      }
      const stopping=await db.sdkWorkflowJob.findMany({where:{state:'CANCEL_REQUESTED'},select:{groupId:true},distinct:['groupId']});
      for(const row of stopping)graphs.changed(row.groupId);
    })());
    let closed=false;
    let calibration:QualificationLoop|undefined;
    const startCalibration=(input:{packs:TrustedPack[];runner?:EvaluationRunner;policy:EvaluationPolicy;
      gate:(peer:Peer,executor:ExecutorV2)=>Promise<'AUTH'|'MODEL'|'RESOURCE'|'WINDOW'|null>;onError:(error:unknown)=>void;intervalMs?:number})=>{
      if(!ready||closed||calibration)throw Error('CALIBRATION_START_INVALID');
      const service=new QualificationService(db,directory,input.packs,input.runner??remoteEvaluation,input.policy,async(peer,executor)=>{
        if(!(await auth.activePeers()).some(p=>p.credentialId===peer.credentialId&&p.groupId===peer.groupId&&p.holderInstanceId===peer.holderInstanceId))return 'AUTH';
        return input.gate(peer,executor);
      });
      const published=new Map<string,string>();
      calibration=new QualificationLoop(service,{targets:async()=>{
        const targets=[],groups=new Map<string,Map<string,DeviceProfileV2>>();
        for(const peer of await auth.activePeers()){
          let holders=groups.get(peer.groupId);
          if(!holders){holders=new Map((await directory.profiles(peer.groupId)).map(p=>[p.holderInstanceId,p]));groups.set(peer.groupId,holders);}
          const profile=holders.get(peer.holderInstanceId);
          if(profile?.deviceId===peer.deviceId)for(const executor of profile.executors)targets.push({peer,targetId:executor.target.targetId});
        }
        return targets;
      },refresh:async groupId=>{
        const states=await db.capabilityState.findMany({where:{groupId},orderBy:{id:'asc'},select:{id:true,revision:true}});
        const revision=JSON.stringify(states);if(published.get(groupId)===revision)return;
        await profiles.refresh(groupId);published.set(groupId,revision);events.changed(groupId);
      },onError:input.onError},input.intervalMs,8,input.policy.maxConcurrent);
      calibration.start();return service;
    };
    return {app,db,identity,store,retention,snapshots,planning,channel,auth,apps,sdk,directory,profiles,allotments,artifacts,traces,remoteEvaluation,jobs,spaces,directTransfers,startCalibration,get epoch(){return epoch;},get ready(){return ready;},restore,
      close:async()=>{if(closed)return;closed=true;ready=false;spaces.close();remoteEvaluation.close();await graphs.close();await jobs.closeBackups();await jobs.batch.close();await retention.close();try{await calibration?.close();await channel.close();await app.close();await db.$disconnect();}finally{await unlock();}}};
  }catch(error){await db.$disconnect();await unlock();throw error;}
}
