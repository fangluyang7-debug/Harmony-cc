import { createHash } from 'node:crypto';
import { ArtifactRefV2, DispatchOfferV2, canonical } from '@harmony/scheduler-core';
import { ArtifactTicket, PinnedEndpoint, transfer } from '@harmony/resource-transport';
export interface ArtifactRoute {endpoint:PinnedEndpoint;ticket:ArtifactTicket;credential:string;}
/** Route/permission providers are trusted host services; task payloads never provide arbitrary URLs or bearer credentials. */
export function artifactPorts(routes:{read(ref:ArtifactRefV2,offer:DispatchOfferV2):Promise<ArtifactRoute>;write(bytes:Buffer,schemaId:string,offer:DispatchOfferV2):Promise<ArtifactRoute>}){
  return {
    read:async(ref:ArtifactRefV2,offer:DispatchOfferV2)=>{
      const route=await routes.read(ref,offer);if(route.ticket.operation!=='READ'||canonical(route.ticket.ref)!==canonical(ref))throw Error('ARTIFACT_ROUTE_SCOPE');
      return (await transfer(route.endpoint,route.ticket,route.credential)).bytes;
    },
    publish:async(bytes:Buffer,schemaId:string,offer:DispatchOfferV2)=>{
      const route=await routes.write(bytes,schemaId,offer),ref=route.ticket.ref;
      if(route.ticket.operation!=='WRITE'||route.ticket.bytes!==bytes.length||ref.schemaId!==schemaId||ref.contentHash!==createHash('sha256').update(bytes).digest('hex'))throw Error('ARTIFACT_ROUTE_SCOPE');
      await transfer(route.endpoint,route.ticket,route.credential,bytes);return structuredClone(ref);
    }
  };
}
