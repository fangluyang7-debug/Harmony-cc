import { Body, Controller, HttpCode, HttpException, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../../persistence/prisma/prisma.service';
import { CandidateSeed } from '../../../adapters/search-provider/search-provider.interface';
import { finalCandidateRank } from '../../sessions/application/final-candidate-rank';

/**
 * Read-only shopping stages exposed one by one so the scheduler can run them as ordinary
 * service capabilities (STATUS §87 R-18: pure computation split from session commits).
 * Nothing here writes business state; identity comes from the business session (JwtAuthGuard).
 */
interface ItemRef { productId?: string; platformName?: string; productUrl?: string; score?: number }
interface PriceStockRequest { requestId: string; items?: ItemRef[]; candidates?: ItemRef[] }
interface RankRequest { requestId: string; items: CandidateSeed[]; filters?: Record<string, unknown> }
const stockStates = new Set(['in_stock', 'out_of_stock', 'unknown']);
const maxItems = 200;
function fail(code: string, status: number): never { throw new HttpException({ code }, status); }
const text = (v: unknown, max = 2048) => typeof v === 'string' && v.length > 0 && v.length <= max;

@Controller('api/v2/stages')
@UseGuards(JwtAuthGuard)
export class ShoppingStagesV2Controller {
  constructor(private readonly prisma: PrismaService) {}

  /** Refresh price and stock from the persisted catalogue. Accepts item refs or a candidate list (productId + score). */
  @Post('price-stock') @HttpCode(200)
  async priceStock(@Body() body: PriceStockRequest) {
    const items = body?.items ?? body?.candidates;
    if (!body || !text(body.requestId, 128) || !Array.isArray(items) || items.length > maxItems ||
        !items.every(i => i && typeof i === 'object' && (text(i.productId, 256) || (text(i.platformName, 128) && text(i.productUrl))) &&
          (i.score === undefined || Number.isFinite(i.score)))) fail('STAGE_INPUT_INVALID', 400);
    const ids = items.map(i => i.productId).filter((v): v is string => typeof v === 'string');
    const urls = items.map(i => i.productUrl).filter((v): v is string => typeof v === 'string');
    const products = items.length ? await this.prisma.product.findMany({ where: { OR: [
      ...(ids.length ? [{ id: { in: ids } }] : []), ...(urls.length ? [{ productUrl: { in: urls } }] : []) ] } }) : [];
    const byId = new Map(products.map(p => [p.id, p])), byUrl = new Map(products.map(p => [`${p.platform}:${p.productUrl}`, p]));
    return { requestId: body.requestId, priceSource: 'catalog', items: items.map(i => {
      const product = (i.productId !== undefined ? byId.get(i.productId) : undefined) ?? (i.productUrl !== undefined ? byUrl.get(`${i.platformName}:${i.productUrl}`) : undefined);
      return { productId: product?.id ?? i.productId ?? null, platformName: product?.platform ?? i.platformName ?? null, productUrl: product?.productUrl ?? i.productUrl ?? null,
        score: i.score ?? null, amount: product?.priceAmount ?? null, currency: product?.currency ?? null,
        stockStatus: product && stockStates.has(product.stockStatus) ? product.stockStatus : 'unknown',
        catalogUpdatedAt: product?.updatedAt?.toISOString() ?? null };
    }) };
  }

  /** Final ordering and filtering of candidate seeds. Pure: same input and filters always give the same order. */
  @Post('rank') @HttpCode(200)
  rank(@Body() body: RankRequest) {
    const filters = body?.filters ?? {};
    if (!body || !text(body.requestId, 128) || !Array.isArray(body.items) || body.items.length > maxItems || typeof filters !== 'object' || Array.isArray(filters) ||
        !body.items.every(i => i && typeof i === 'object' && text(i.platformName, 128) && text(i.productUrl) && typeof i.amount === 'string' && stockStates.has(i.stockStatus)) ||
        (filters.sortRule !== undefined && !['relevance_desc', 'price_asc', 'price_desc'].includes(String(filters.sortRule))) ||
        (filters.stockOnly !== undefined && typeof filters.stockOnly !== 'boolean') ||
        [filters.priceMin, filters.priceMax].some(v => v !== undefined && v !== null && !/^\d{1,100}(\.\d{1,100})?$/.test(String(v))))
      fail('STAGE_INPUT_INVALID', 400);
    try { return { requestId: body.requestId, items: finalCandidateRank(body.items, filters) }; }
    catch { fail('STAGE_INPUT_INVALID', 400); }
  }
}
