import https from 'node:https';
import { ArtifactChannel, ArtifactPeer, ArtifactSchema } from '@harmony/resource-transport';

/** Installed PC data endpoint; credentials are checked by the supplied authenticated control adapter. */
export function createArtifactEndpoint(config:{directory:string;domain:'REAL'|'SIMULATED';key:string;certificate:string;
  authenticate:(credential:string)=>Promise<ArtifactPeer>;schemas:ReadonlyMap<string,ArtifactSchema>}){
  const channel=new ArtifactChannel(config.directory,config.domain,config.authenticate,config.schemas);channel.sweep();
  const server=https.createServer({key:config.key,cert:config.certificate},(request,response)=>{
    if(!request.url?.startsWith('/v2/artifacts/')){response.writeHead(404).end();return;}void channel.handle(request,response);
  });
  return {server,channel};
}
