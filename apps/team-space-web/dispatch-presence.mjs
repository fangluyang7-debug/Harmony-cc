import {sample} from './dispatch-view.mjs';

// Filter the presentation only. Keep the full snapshot for history and reconnect.
export function visibleHolder(holder, now) {
  return holder.controlState === 'ONLINE' && holder.evidenceFresh === true &&
    sample(holder.profile.ownerActivity, now).value !== null &&
    sample(holder.profile.foreground, now).value === 'FOREGROUND';
}
export function visibleDevices(devices, now) {
  return devices.filter(device => device.paired !== false)
    .map(device => ({...device, holders: device.holders.filter(holder => visibleHolder(holder, now))}))
    .filter(device => device.holders.length > 0);
}
export function visibleNetwork(network, devices) {
  const holders = new Set(devices.flatMap(device => device.holders.map(holder =>
    JSON.stringify([device.id, holder.profile.holderInstanceId]))));
  return network.filter(state => holders.has(JSON.stringify([state.deviceId, state.holderInstanceId])));
}
