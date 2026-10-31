// Read-only verification after a run; never prints credentials.
const fs = require('node:fs'), path = require('node:path');
const { PrismaClient } = require('../../services/coordinator/generated/client');
async function main() {
  const directory = path.resolve(process.argv[2]);
  const report = { verifiedAt: new Date().toISOString(), run: path.basename(directory), note: 'The revoke endpoint returns HTTP 201. The original benchmark recorded this successful response as revokeError; subsequent read-only verification follows.', checks: [] };
  const db = new PrismaClient({ datasources: { db: { url: 'file:' + path.join(directory, 'coordinator/coordinator.sqlite').replaceAll('\\', '/') } } });
  try {
    const credentials = await db.credential.findMany({ select: { revoked: true } });
    report.checks.push({ env: 'local', credentials: credentials.length, allRevoked: credentials.length > 0 && credentials.every(c => c.revoked) });
  } finally { await db.$disconnect(); }
  const { connection } = JSON.parse(fs.readFileSync(path.join(directory, 'cloud/agent/agent.json')));
  const response = await fetch(new URL('/v2/jobs/latency-cleanup-check', connection.address), { headers: { Authorization: 'Bearer ' + connection.credential }, signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  report.checks.push({ env: 'cloud', protectedEndpoint: '/v2/jobs/latency-cleanup-check', protectedEndpointStatus: response.status, reason: data.message, credentialRejected: response.status === 400 && data.message === 'CREDENTIAL_REVOKED' });
  fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2));
  if (!report.checks[0].allRevoked || !report.checks[1].credentialRejected) throw Error('CLEANUP_NOT_VERIFIED');
  console.log('PASS: local credential revoked in database; cloud protected endpoint returns CREDENTIAL_REVOKED.');
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
