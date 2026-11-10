import { Bootstrap, Installation } from './NativePlatform';
export interface PairingHistory {previousDeviceId?:string;knownDeviceIds:string[];}
/** Device IDs are coordinator-scoped. A new coordinator cannot migrate a foreign ID. */
export function pairingHistory(bootstrap:Bootstrap,previous:Installation|null,stored:Installation[]):PairingHistory{
 const same=(i:Installation):boolean=>i.bootstrap.domain===bootstrap.domain&&i.bootstrap.invitation.fingerprint===bootstrap.invitation.fingerprint;
 return {previousDeviceId:previous!==null&&same(previous)?previous.paired.peer.deviceId:undefined,knownDeviceIds:stored.filter(same).map(i=>i.paired.peer.deviceId)};
}
