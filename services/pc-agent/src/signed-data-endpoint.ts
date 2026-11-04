import https from 'node:https';
import {createSignedDataHandler} from '@harmony/resource-transport';
/** PC and authenticated relay share the same single-use signed byte protocol. */
export function createSignedDataEndpoint(config:Parameters<typeof createSignedDataHandler>[0]){
  const data=createSignedDataHandler(config);
  const server=https.createServer({key:config.key,cert:config.certificate,maxHeaderSize:16384},data.handle);
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,channel:data.channel};
}
