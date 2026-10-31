import https from 'node:https';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { WebSocket } from 'ws';
import { MessageEnvelopeV2, validMessageEnvelopeV2, validDispatchOfferV2, protocolId } from '@harmony/scheduler-core';
import { DurableLedger } from './durable-ledger';
import { pinOptions } from '@harmony/resource-transport';

export interface RecoveryConnection {
  address:string;certificate:string;fingerprint:string;credential:string;domain:'REAL'|'SIMULATED';tlsMode?:'pinned'|'public';
}
export function pinned(connection:RecoveryConnection):https.RequestOptions{
  const url=new URL(connection.address),fingerprint=new X509Certificate(connection.certificate).fingerprint256.replaceAll(':','').toLowerCase();
  if(url.protocol!=='https:'||url.pathname!=='/'||url.username||url.password||url.search||url.hash||fingerprint!==connection.fingerprint||
    !/^[A-Za-z0-9_-]{43}$/.test(connection.credential)||!['REAL','SIMULATED'].includes(connection.domain))throw Error('CONNECTION_INVALID');
  return pinOptions(connection);
}
async function identity(connection:RecoveryConnection){
  const options=pinned(connection);
  return new Promise<{coordinatorId:string;epoch:number}>((resolve,reject)=>{
    const request=https.get(new URL('/v2/identity',connection.address),options,response=>{
      let text='';response.on('data',data=>{text+=data;if(Buffer.byteLength(text)>8192)request.destroy(Error('IDENTITY_TOO_LARGE'));});
      response.on('error',reject);response.on('end',()=>{try{
        const v=JSON.parse(text);
        if(response.statusCode!==200||!v||Object.keys(v).sort().join('|')!=='coordinatorId|domain|epoch|version'||v.version!==2||v.domain!==connection.domain||
          !protocolId(v.coordinatorId)||!Number.isSafeInteger(v.epoch)||v.epoch<1)throw Error('IDENTITY_INVALID');resolve(v);
      }catch{reject(Error('IDENTITY_INVALID'));}});
    });request.setTimeout(10000,()=>request.destroy(Error('IDENTITY_TIMEOUT')));request.on('error',reject);
  });
}

export interface LiveControl {
  dispatch(message:MessageEnvelopeV2):void;
  state(ready:boolean,epoch:number):void;
  acknowledged?(message:MessageEnvelopeV2):void;
  evaluationChanged?():void;
}
/** Recovery-only by default. Optional host dispatch is enabled only after the recovery request is acknowledged. */
export class RecoveryClient {
  private socket:WebSocket|undefined;
  private work:Promise<void>=Promise.resolve();
  private closed:Promise<void>=Promise.resolve();
  private stopped=true;
  private closing=false;
  private loop:Promise<void>|undefined;
  private wake:(()=>void)|undefined;
  private pumpCurrent:()=>Promise<void>=async()=>{};
  constructor(private readonly ledger:DurableLedger,private readonly connection:RecoveryConnection,private readonly onError:(error:unknown)=>void=()=>{},private readonly live?:LiveControl){}
  async connect():Promise<void>{
    if(this.closing||this.socket)throw Error('CLIENT_UNAVAILABLE');
    const info=await identity(this.connection);if(this.closing)throw Error('CLIENT_STOPPED');
    this.ledger.bindChannel(info.coordinatorId,info.epoch);
    const hello=this.ledger.channelHello(),state=this.ledger.snapshot();
    const socket=new WebSocket(new URL('/v2/channel',this.connection.address).toString().replace('https:','wss:'),{
      ...pinned(this.connection),headers:{Authorization:'Bearer '+this.connection.credential},maxPayload:262144,perMessageDeflate:false,handshakeTimeout:10000});
    this.socket=socket;let ready=false,liveReady=false,queued=0;const sent=new Set<string>();let watchdog:NodeJS.Timeout|undefined;
    let accepted:()=>void,failed:(e:Error)=>void;
    const started=new Promise<void>((resolve,reject)=>{accepted=resolve;failed=reject;});
    const timeout=setTimeout(()=>socket.terminate(),10000);
    const send=async(m:MessageEnvelopeV2)=>{
      const text=JSON.stringify(m);
      if(socket.readyState!==WebSocket.OPEN)throw Error('CHANNEL_NOT_OPEN');
      if(socket.bufferedAmount+Buffer.byteLength(text)>1048576)throw Error('CHANNEL_BACKPRESSURE');
      await new Promise<void>((resolve,reject)=>socket.send(text,e=>e?reject(e):resolve()));
    };
    const pump=async()=>{
      if(!ready||socket.readyState!==WebSocket.OPEN)return;
      const pending=this.ledger.pendingMessages();
      for(const m of pending)if(!sent.has(m.messageId)){await send(m);sent.add(m.messageId);this.ledger.sentMessage(m.messageId);}
      if(this.ledger.pendingMessages().length&&!watchdog)watchdog=setTimeout(()=>socket.terminate(),10000);
      if(!this.ledger.pendingMessages().length&&watchdog){clearTimeout(watchdog);watchdog=undefined;}
    };
    this.pumpCurrent=pump;
    this.closed=new Promise(resolve=>socket.once('close',(code,reason)=>{
      clearTimeout(timeout);if(watchdog)clearTimeout(watchdog);if(this.socket===socket)this.socket=undefined;
      liveReady=false;this.live?.state(false,info.epoch);
      if(!this.closing&&code!==1000){const detail=reason.toString();this.onError(Error('CHANNEL_CLOSED_'+code+(/^[A-Z_]+$/.test(detail)?'_'+detail:'')));}
      failed!(Error('CHANNEL_CLOSED'));resolve();
    }));
    socket.on('error',()=>{failed!(Error('CHANNEL_CONNECTION_FAILED'));});
    socket.on('open',()=>{void send(hello).catch(()=>socket.terminate());});
    socket.on('message',(data,binary)=>{
      if(binary||queued>=64){socket.terminate();return;}queued++;
      this.work=this.work.then(async()=>{
        const m=JSON.parse(data.toString()) as MessageEnvelopeV2;
        if(!validMessageEnvelopeV2(m,[])||m.groupId!==state.groupId||m.senderInstanceId!==info.coordinatorId||m.coordinatorEpoch!==info.epoch)throw Error('SERVER_MESSAGE_INVALID');
        const payload=JSON.parse(m.payload);
        if(m.type==='Ack'){
          if(!payload||Object.keys(payload).join('|')!=='messageId'||!protocolId(payload.messageId)||m.ackOf!==payload.messageId)throw Error('ACK_INVALID');
          if(payload.messageId===hello.messageId){
            if(!ready)this.ledger.requestRecovery(true);
            ready=true;clearTimeout(timeout);accepted!();
          }
          else{
            const pending=this.ledger.pendingMessages().find(p=>p.messageId===payload.messageId);
            this.ledger.acknowledgeMessage(payload.messageId);
            if(pending)this.live?.acknowledged?.(pending);
            if(pending?.type==='RecoveryRequest'&&!liveReady){liveReady=true;this.live?.state(true,info.epoch);}
          }
        }else if(m.type==='EvaluationChanged'){
          if(!payload||Object.keys(payload).length)throw Error('EVALUATION_HINT_INVALID');
          if(liveReady)this.live?.evaluationChanged?.();
        }else if(m.type==='AttemptStatusQuery')this.ledger.answerStatus(m);
        else if(m.type==='DispatchOffer'){
          // Hello may race a previously queued offer. RecoveryRequest supersedes it; never ACK or execute it here.
          if(!validDispatchOfferV2(payload)||payload.task.groupId!==state.groupId)throw Error('OFFER_INVALID');
          if(liveReady)this.live?.dispatch(m);
        }else throw Error('SERVER_MESSAGE_UNSUPPORTED');
        await pump();
      }).catch(error=>{if(!this.closing)this.onError(error);socket.terminate();}).finally(()=>{queued--;});
    });
    await started;
  }
  start(){
    if(this.loop||this.closing)throw Error('CLIENT_STARTED');this.stopped=false;
    this.loop=(async()=>{
      let delay=250;
      while(!this.stopped){
        try{await this.connect();await this.closed;await this.work;}catch(error){if(!this.stopped)this.onError(error);this.socket?.terminate();await this.closed;await this.work;}
        if(this.stopped)break;
        await new Promise<void>(resolve=>{const timer=setTimeout(resolve,delay);this.wake=()=>{clearTimeout(timer);resolve();};});
        this.wake=undefined;delay=Math.min(delay*2,10000);
      }
    })().finally(()=>{this.loop=undefined;});
  }
  /** Host calls after local engine reconciliation; pending intent is already committed with settlement. */
  flush(){
    this.work=this.work.then(()=>this.pumpCurrent()).catch(error=>{if(!this.closing)this.onError(error);this.socket?.terminate();});return this.work;
  }
  async close(){this.closing=true;this.stopped=true;this.wake?.();this.socket?.terminate();await this.closed;await this.work;await this.loop;}
}
