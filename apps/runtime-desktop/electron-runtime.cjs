const {main} = require('../../scripts/runtime-desktop.cjs');
let desktop, stopping = false, stopRequested = false;
async function stop() {
  stopRequested = true;
  if (stopping || !desktop) return;
  stopping = true;
  const worker = desktop.control.child;
  if (worker) {
    const exited = new Promise(resolve => worker.once('exit', resolve));
    desktop.control.stop();
    await exited;
  }
  desktop.server.close(() => process.exit(0));
  desktop.server.closeIdleConnections();
}
process.on('message', message => { if (message.type === 'shutdown') void stop(); });
process.on('disconnect', () => { void stop(); });
main({openBrowser: false, role: process.argv[2] || 'agent'}).then(value => {
  desktop = value;
  if (process.connected && !stopRequested) process.send({type: 'ready', url: value.url});
  else void stop();
}).catch(error => { console.error(error.message); process.exit(1); });
