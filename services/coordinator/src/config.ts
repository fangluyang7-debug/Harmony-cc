import path from 'node:path';
import { isIP } from 'node:net';

export interface CoordinatorConfig { dataDir:string; host:string; port:number; domain:'REAL'|'SIMULATED'; certificateHost:string; openssl:string; }
export function loadConfig(env:NodeJS.ProcessEnv):CoordinatorConfig {
  const port=Number(env.COORDINATOR_PORT??7443),host=env.COORDINATOR_HOST??'127.0.0.1',certificateHost=env.COORDINATOR_CERTIFICATE_HOST??'localhost';
  const domain=env.COORDINATOR_DOMAIN??'REAL';
  if(!Number.isSafeInteger(port)||port<0||port>65535||!host||(!isIP(certificateHost)&&!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(certificateHost))||!['REAL','SIMULATED'].includes(domain))throw new Error('COORDINATOR_CONFIG_INVALID');
  const dataDir=path.resolve(env.COORDINATOR_DATA_DIR??path.join(__dirname,'../data',domain.toLowerCase()));
  return {dataDir,host,port,domain:domain as CoordinatorConfig['domain'],certificateHost,openssl:env.COORDINATOR_OPENSSL??'openssl'};
}
export function databaseUrl(config:CoordinatorConfig):string{return 'file:'+path.join(config.dataDir,'coordinator.sqlite').replaceAll('\\','/');}
