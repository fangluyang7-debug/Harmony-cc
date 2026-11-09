import { Body, Controller, Headers, HttpCode, HttpException, Post, Req, UseGuards } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { JwtTokenService } from '../../auth/application/jwt-token.service';
import { AuthenticatedRequest } from '../../auth/auth.types';
import { PrismaService } from '../../../persistence/prisma/prisma.service';
import { SessionsService } from '../application/sessions.service';
import { CandidateSeed } from '../../../adapters/search-provider/search-provider.interface';
import { normalizeProductCategory } from '../../../common/catalog/product-categories';

/**
 * The single write step of a scheduled shopping workflow (STATUS §87 R-18c/d, §12 items 5 and 7).
 *
 * Authorization travels with the task as a short-lived ticket minted here for the logged-in user:
 * bound to one workflow, one input digest and one capability, expiring with the task budget. The
 * coordinator and executing hosts only carry it; only this service can verify it.
 *
 * Writes are idempotent: all ids derive from the Idempotency-Key, so a retried or re-planned commit
 * returns the existing session instead of creating a second one. `X-Dry-Run: true` performs every
 * check and reports what would be written without touching the database (used for qualification).
 */
interface TicketRequest { workflowId: string; inputHash: string; scope: string[]; ttlMs?: number }
interface CommitQuery { text: string; categoryHint?: string; filters?: Record<string, unknown> }
interface CommitRequest { ticket: string; query: CommitQuery; candidates: CandidateSeed[]; answer?: string }
type TicketPayload = { kind: 'service-ticket'; sub: string; wf: string; ih: string; scope: string[]; jti: string; exp: number };
export const commitCapability = 'shopping.commit.v1';
export const dryRunTicket = 'dry-run';
const stockStates = new Set(['in_stock', 'out_of_stock', 'unknown']);
const money = /^\d{1,100}(\.\d{1,100})?$/;
const idText = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const text = (v: unknown, max = 2048) => typeof v === 'string' && v.length > 0 && v.length <= max;
function fail(code: string, status: number): never { throw new HttpException({ code }, status); }
const canonical = (value: unknown): string => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value as object).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}' : JSON.stringify(value);
export const commitInputHash = (request: Omit<CommitRequest, 'ticket'>) => createHash('sha256').update(canonical(request)).digest('hex');
const derivedId = (prefix: string, key: string) => prefix + '_' + createHash('sha256').update(prefix + ':' + key).digest('hex').slice(0, 24);

@Controller('api/v2')
@UseGuards(JwtAuthGuard)
export class ShoppingCommitV2Controller {
  constructor(private readonly prisma: PrismaService, private readonly sessions: SessionsService, private readonly jwt: JwtTokenService) {}

  /** Mint a task-scoped ticket for the logged-in user. Never stores credentials on the coordinator. */
  @Post('tickets') @HttpCode(200)
  ticket(@Req() request: AuthenticatedRequest, @Body() body: TicketRequest) {
    const user = request.user;
    if (!user || !body || !idText.test(body.workflowId ?? '') || !/^[a-f0-9]{64}$/.test(body.inputHash ?? '') || !Array.isArray(body.scope) || !body.scope.length || body.scope.length > 8 ||
        !body.scope.every(s => idText.test(s)) || (body.ttlMs !== undefined && (!Number.isSafeInteger(body.ttlMs) || body.ttlMs < 1000 || body.ttlMs > 600000))) fail('TICKET_REQUEST_INVALID', 400);
    const ttlMs = body.ttlMs ?? 60000;
    const payload: TicketPayload = { kind: 'service-ticket', sub: user.userId, wf: body.workflowId, ih: body.inputHash, scope: body.scope, jti: randomUUID(), exp: Math.floor((Date.now() + ttlMs) / 1000) };
    return { ticket: this.jwt.signScoped(payload), expiresAt: payload.exp * 1000 };
  }

  @Post('stages/commit') @HttpCode(200)
  async commit(@Body() body: CommitRequest, @Headers('idempotency-key') key: string | undefined, @Headers('x-dry-run') dryRunHeader: string | undefined) {
    const dryRun = dryRunHeader === 'true' || dryRunHeader === '1';
    if (!body || typeof body !== 'object' || !text(body.ticket, 4096) || !body.query || typeof body.query !== 'object' || !text(body.query.text, 2000) ||
        (body.query.categoryHint !== undefined && !text(body.query.categoryHint, 128)) || (body.query.filters !== undefined && (!body.query.filters || typeof body.query.filters !== 'object' || Array.isArray(body.query.filters))) ||
        !Array.isArray(body.candidates) || body.candidates.length > 200 || (body.answer !== undefined && !text(body.answer, 8000)) ||
        !body.candidates.every(c => c && typeof c === 'object' && text(c.platformName, 128) && text(c.productUrl) && typeof c.amount === 'string' && money.test(c.amount) && stockStates.has(c.stockStatus) && typeof c.title === 'string'))
      fail('STAGE_INPUT_INVALID', 400);
    if (!idText.test(key ?? '')) fail('IDEMPOTENCY_KEY_REQUIRED', 400);
    const { ticket, ...request } = body;
    let userId: string | null = null;
    if (ticket === dryRunTicket) { if (!dryRun) fail('TICKET_INVALID', 401); }
    else {
      const payload = this.jwt.verifyScoped(ticket) as Partial<TicketPayload>;
      if (payload.kind !== 'service-ticket' || typeof payload.sub !== 'string' || !Array.isArray(payload.scope) || !payload.scope.includes(commitCapability)) fail('TICKET_INVALID', 401);
      if (payload.ih !== commitInputHash(request)) fail('TICKET_INPUT_MISMATCH', 401);
      userId = payload.sub;
    }
    const sessionId = derivedId('sess', key!), assetId = derivedId('asset', key!), filterId = derivedId('filter', key!);
    const existing = await this.prisma.querySession.findUnique({ where: { id: sessionId } });
    const category = normalizeProductCategory(request.query.categoryHint ?? request.query.text);
    const filters = request.query.filters ?? {};
    if (dryRun) return { dryRun: true, sessionId, wouldCreate: !existing, writes: existing ? [] : ['imageAsset', 'querySession', 'filterSnapshot', 'candidateSnapshot'], candidateCount: request.candidates.length };
    if (existing) return { dryRun: false, sessionId, created: false, replay: true, stateVersion: existing.stateVersion };
    try {
      await this.prisma.imageAsset.create({ data: { id: assetId, assetGroupId: assetId, variantType: 'demo_asset', isPrimaryRecognitionAsset: false, sourceType: 'text_query', bucketGroup: 'text-query', objectKey: `sessions/${sessionId}/scheduled-commit.json`, uploadStatus: 'registered', ownerUserId: userId } });
      await this.prisma.querySession.create({ data: { id: sessionId, assetId, userId, status: 'processing', stage: 'runtime_persist', entrySource: 'scheduler', categoryHint: category, degraded: false, currentTurnIndex: 0,
        filterSnapshots: { create: { id: filterId, turnIndex: 0, stockOnly: filters.stockOnly === true, sortRule: typeof filters.sortRule === 'string' ? filters.sortRule : 'relevance_desc', rawJson: JSON.stringify(filters) } } } });
    } catch (error) {
      // A concurrent retry with the same key already created the session: that is the replay case, not a failure.
      const again = await this.prisma.querySession.findUnique({ where: { id: sessionId } });
      if (again) return { dryRun: false, sessionId, created: false, replay: true, stateVersion: again.stateVersion };
      throw error;
    }
    const candidateSnapshotId = await this.sessions.writeRuntimeCandidateSnapshot({ sessionId, turnIndex: 0, candidates: request.candidates, fallback: null, appliedFilter: filters });
    await this.prisma.querySession.update({ where: { id: sessionId }, data: { status: 'ready', stage: 'candidate_ready', stateVersion: 1 } });
    return { dryRun: false, sessionId, created: true, replay: false, candidateSnapshotId, stateVersion: 1 };
  }
}
