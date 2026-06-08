/*
Created by Franz Zemen 05/11/2026
License Type: UNLICENSED
*/

import {Provenance} from '@franzzemen/admin-identity';
import {EndpointApplicationsApi, getSessionOwner} from '@franzzemen/endpoint-application';
import {AccountOwner} from '@franzzemen/endpoint-financial-identity';
import {logAndEnhanceError} from '@franzzemen/enhanced-error';
import {ExecutionContext} from '@franzzemen/execution-context';
import {
  AsOfTradeYieldSegmentSummary,
  SinceTradeYieldSegmentSummary,
  SubTradeYieldUnit,
  TradeUUID,
  TradeYieldSegment,
  TradeYieldSegmentSummary,
} from '@franzzemen/financial-identity';
import {LoggerApi} from '@franzzemen/logger';
import {Datestamp} from '@franzzemen/utility';
import {Kysely, sql} from 'kysely';
import type {Selectable} from 'kysely';
import type {Database, OpenTradeYieldSummariesTable} from '@franzzemen/brokenstock-postgres-ddl/schema-types';

import {
  _TradeDailyMTMSeries,
  dailyMtmRowToRecord,
  DailyMtmRow,
} from '../identity/_trade-daily-mtm-series.js';
import {
  _SubTradeYieldUnit,
  toSubTradeYieldUnit,
  unitRowToRecord,
} from '../identity/_sub-trade-yield-unit.js';
import {
  _TradeYieldSegment,
  segmentRowToRecord,
  toTradeYieldSegment,
} from '../identity/_trade-yield-segment.js';
import {
  _OpenTradeYieldSummary,
  toOpenTradeYieldSummary,
} from '../identity/_open-trade-yield-summary.js';
import {
  _AsOfTradeYieldSummary,
  asOfSummaryRowToRecord,
  AsOfSummaryRow,
  toAsOfTradeYieldSummary,
} from '../identity/_as-of-trade-yield-summary.js';
import {
  _SinceTradeYieldSummary,
  sinceSummaryRowToRecord,
  SinceSummaryRow,
  toSinceTradeYieldSummary,
} from '../identity/_since-trade-yield-summary.js';
import {
  asOfContext,
  OPEN_CONTEXT,
  padEpoch,
  sinceContext,
  YieldContext,
} from '../identity/yield-context.js';

/** Either end inclusive; either may be omitted to mean "open-ended." */
export type DateRange = {
  from?: Datestamp;
  to?: Datestamp;
};

/**
 * Trusted (session-owner-derived, capability-bypassing) read/write API for the
 * trade-yield persistence tables. Repointed to kysely/Postgres (Era 4 / 4a).
 *
 * Owner is derived from the execution context via `getSessionOwner(ec)`. Callers
 * must set the synthetic session to the target owner before invoking these
 * methods on behalf of a non-current user (the orchestrator does this when
 * fanning out per-owner work).
 *
 * The API is organized in three layers:
 *   1. Fact-row I/O: putSegments / putSubTradeYieldUnits + matching queries.
 *   2. Summary I/O per context: open / as-of / since.
 *   3. Composite reads: `getOpenSummary(tradeUuid)` etc. that bundle the
 *      summary row + segment + unit hydration into one DTO.
 *   4. Cascade-delete primitives keyed by trade uuid OR by context.
 */
/**
 * Thrown by `putOpenTradeSummary` / `putAsOfTradeSummary` when the caller-supplied
 * `existsCheck` returns false — i.e. the underlying trade row no longer exists in
 * `financials.trades` at write time. Persisting a summary for a deleted trade
 * creates an orphan that distorts every downstream aggregate. The error is
 * deliberately a distinct class so callers can `catch` it specifically and treat
 * a race-with-cascade-delete as a benign skip (log + continue) rather than a
 * chunk failure. See `feedback_never_instrument_node_modules` for the discipline
 * rule that surfaced this guard.
 */
export class OrphanTradeError extends Error {
  readonly tradeUuid: string;
  readonly persistOp: 'open' | 'as-of';
  constructor(tradeUuid: string, persistOp: 'open' | 'as-of') {
    super(`Refusing to persist ${persistOp} summary — tradeUuid=${tradeUuid} does not exist`);
    this.name = 'OrphanTradeError';
    this.tradeUuid = tradeUuid;
    this.persistOp = persistOp;
  }
}

export function isOrphanTradeError(err: unknown): err is OrphanTradeError {
  return err instanceof Error && err.name === 'OrphanTradeError';
}

export class TradeYieldPersistenceTrustedApi extends EndpointApplicationsApi {
  #log: LoggerApi;
  #db: Kysely<Database>;

  constructor(ec: ExecutionContext, db: Kysely<Database>) {
    super(ec, db);
    this.#log = new LoggerApi(ec, 'trade-yield-persistence', 'trade-yield-persistence.trusted.api', TradeYieldPersistenceTrustedApi.name);
    this.#db = db;
  }

  // ── Fact-row writes ─────────────────────────────────────────────────────────

  /**
   * Batch-put per-segment fact rows. Inserts each `_TradeYieldSegment` into
   * `trade_yield_segments` (its scalar columns) AND its `transactionPortions[]`
   * into the child `trade_yield_segment_transaction_portions` table. Provenance is
   * stamped onto every row (persistence-row-provenance.prd.md D1).
   *
   * Each row's `segment.uuid` (the PK `segment_id`) and `context` must be populated
   * by the caller (`buildSegmentRow` does this).
   */
  async putSegmentRows(rows: _TradeYieldSegment[], provenance: Provenance): Promise<void> {
    const log = this.#log.setMethod('putSegmentRows');
    if (rows.length === 0) return;
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      for (const r of rows) {
        const s = r.segment;
        if (!s.uuid) throw new Error('putSegmentRows: segment.uuid is required');
        await this.#db.insertInto('trade_yield_segments').values({
          segment_id: s.uuid,
          owner,
          trade_id: r.tradeUuid,
          context: r.context,
          sub_trade_uuids: s.subTradeUuids,
          archetype: s.archetype,
          denominator: s.denominator as unknown as string,
          start_epoch: s.startEpoch as unknown as string,
          end_epoch: (s.endEpoch === null ? null : s.endEpoch) as unknown as string | null,
          start_boundary_kind: s.startBoundaryKind,
          end_boundary_kind: s.endBoundaryKind ?? null,
          gain: s.gain as unknown as string,
          mtm_price_at_boundary: (s.markToMarketPriceAtBoundary ?? null) as unknown as string | null,
          days: s.days,
          yield: s.yield as unknown as string,
          fees_and_commissions: s.feesAndCommissions as unknown as string,
          explanation: s.explanation ?? null,
          leaf_chain_uuids: s.leafChainUuids ?? null,
          prior_segment_uuids: s.priorSegmentUuids ?? null,
          closing_transaction_uuids: s.closingTransactionUuids ?? null,
          opening_transaction_uuids: s.openingTransactionUuids ?? null,
          family_cluster_id: s.familyClusterId ?? null,
          boundary_qty_delta_prior: (s.boundaryQuantityDelta?.prior ?? null) as unknown as string | null,
          boundary_qty_delta_current: (s.boundaryQuantityDelta?.current ?? null) as unknown as string | null,
          started_by: provenance.startedBy,
          job_id: provenance.jobId,
          writer: provenance.writerLambda,
          writer_version: provenance.writerVersion,
          written_at: provenance.writtenAt as unknown as string,
          created_by: owner,
          updated_by: owner,
        }).execute();

        if (s.transactionPortions.length > 0) {
          await this.#db.insertInto('trade_yield_segment_transaction_portions').values(
            s.transactionPortions.map(p => ({
              segment_id: s.uuid!,
              transaction_id: p.transactionUuid,
              portion: p.quantityPortion as unknown as string,
              created_by: owner,
            })),
          ).execute();
        }
      }
      log.info(`putSegmentRows: wrote ${rows.length} rows`);
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /**
   * Batch-put per-sub-trade-yield-unit fact rows into `sub_trade_yield_units`.
   * Provenance-stamped per D1.
   */
  async putSubTradeYieldUnitRows(rows: _SubTradeYieldUnit[], provenance: Provenance): Promise<void> {
    const log = this.#log.setMethod('putSubTradeYieldUnitRows');
    if (rows.length === 0) return;
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      for (const r of rows) {
        const u = r.unit;
        if (!u.uuid) throw new Error('putSubTradeYieldUnitRows: unit.uuid is required');
        await this.#db.insertInto('sub_trade_yield_units').values({
          unit_id: u.uuid,
          owner,
          trade_id: r.tradeUuid,
          context: r.context,
          sub_trade_id: u.subTradeUuid,
          symbol: u.symbol,
          archetype: u.archetype,
          denominator: u.denominator as unknown as string,
          start_epoch: u.startEpoch as unknown as string,
          end_epoch: (u.endEpoch === null ? null : u.endEpoch) as unknown as string | null,
          gain: u.gain as unknown as string,
          mtm_price_at_boundary: (u.markToMarketPriceAtBoundary ?? null) as unknown as string | null,
          days: u.days,
          yield: u.yield as unknown as string,
          fees_and_commissions: u.feesAndCommissions as unknown as string,
          explanation: u.explanation ?? null,
          started_by: provenance.startedBy,
          job_id: provenance.jobId,
          writer: provenance.writerLambda,
          writer_version: provenance.writerVersion,
          written_at: provenance.writtenAt as unknown as string,
          created_by: owner,
          updated_by: owner,
        }).execute();
      }
      log.info(`putSubTradeYieldUnitRows: wrote ${rows.length} rows`);
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /**
   * Convenience constructor for a `_TradeYieldSegment` row from a (context, segment) pair.
   * The segment's `uuid` must already be populated by the upstream evaluator.
   */
  buildSegmentRow(context: YieldContext, segment: TradeYieldSegment): _TradeYieldSegment {
    const owner = getSessionOwner(this.ec) as AccountOwner;
    if (!segment.uuid) throw new Error('buildSegmentRow: segment.uuid is required');
    return {
      owner,
      context,
      tradeUuid: segment.tradeUuid,
      segment,
    };
  }

  /** Convenience constructor for a `_SubTradeYieldUnit` row. */
  buildSubTradeYieldUnitRow(context: YieldContext, unit: SubTradeYieldUnit): _SubTradeYieldUnit {
    const owner = getSessionOwner(this.ec) as AccountOwner;
    if (!unit.uuid) throw new Error('buildSubTradeYieldUnitRow: unit.uuid is required');
    return {
      owner,
      context,
      tradeUuid: unit.tradeUuid,
      subTradeUuid: unit.subTradeUuid,
      unit,
    };
  }

  // ── Fact-row queries ────────────────────────────────────────────────────────

  /**
   * Return every segment fact row for one (trade, context) — the input to summary
   * hydration on read. Reassembles each segment's `transactionPortions[]` from the
   * child table.
   */
  async getSegmentRowsForTradeAndContext(tradeUuid: TradeUUID, context: YieldContext): Promise<_TradeYieldSegment[]> {
    const log = this.#log.setMethod('getSegmentRowsForTradeAndContext');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      const segRows = await this.#db.selectFrom('trade_yield_segments').selectAll()
        .where('owner', '=', owner)
        .where('trade_id', '=', tradeUuid)
        .where('context', '=', context)
        .execute();
      if (segRows.length === 0) return [];
      const portionRows = await this.#db.selectFrom('trade_yield_segment_transaction_portions').selectAll()
        .where('segment_id', 'in', segRows.map(r => r.segment_id))
        .execute();
      const portionsBySegment = new Map<string, typeof portionRows>();
      for (const p of portionRows) {
        const arr = portionsBySegment.get(p.segment_id);
        if (arr) arr.push(p);
        else portionsBySegment.set(p.segment_id, [p]);
      }
      return segRows.map(r => segmentRowToRecord(r, portionsBySegment.get(r.segment_id) ?? []));
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /**
   * Return every sub-trade-yield-unit fact row for one (trade, context).
   */
  async getSubTradeYieldUnitRowsForTradeAndContext(tradeUuid: TradeUUID, context: YieldContext): Promise<_SubTradeYieldUnit[]> {
    const log = this.#log.setMethod('getSubTradeYieldUnitRowsForTradeAndContext');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      const rows = await this.#db.selectFrom('sub_trade_yield_units').selectAll()
        .where('owner', '=', owner)
        .where('trade_id', '=', tradeUuid)
        .where('context', '=', context)
        .execute();
      return rows.map(unitRowToRecord);
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  // ── OPEN summary I/O ────────────────────────────────────────────────────────

  /**
   * Atomic write of an open-trade summary AND replacement of its fact rows.
   * Replaces ALL open-context segment + unit rows for the trade with the supplied
   * set, then upserts the summary row. The supplied summary's segments / units must
   * have their `uuid` fields populated.
   *
   * Optional `existsCheck` is invoked BEFORE any write or delete to verify the
   * underlying trade still exists in `financials.trades`. If it returns false,
   * throws `OrphanTradeError` and persists nothing.
   */
  async putOpenTradeSummary(
    summary: TradeYieldSegmentSummary,
    provenance: Provenance,
    opts?: {existsCheck?: () => Promise<boolean>},
  ): Promise<void> {
    const log = this.#log.setMethod('putOpenTradeSummary');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      if (opts?.existsCheck) {
        const exists = await opts.existsCheck();
        if (!exists) throw new OrphanTradeError(summary.tradeUuid, 'open');
      }
      await this.deleteOpenTradeRowsByTrade(summary.tradeUuid);

      const segmentRows = summary.segments.map(s => this.buildSegmentRow(OPEN_CONTEXT, s));
      const unitRows = summary.subTradeYieldUnits.map(u => this.buildSubTradeYieldUnitRow(OPEN_CONTEXT, u));
      if (segmentRows.length > 0) await this.putSegmentRows(segmentRows, provenance);
      if (unitRows.length > 0) await this.putSubTradeYieldUnitRows(unitRows, provenance);

      await this.#db.insertInto('open_trade_yield_summaries').values({
        owner,
        trade_id: summary.tradeUuid,
        peak_simultaneous_car: summary.peakSimultaneousCaR as unknown as string,
        start_epoch: summary.startEpoch as unknown as string,
        end_epoch: (summary.endEpoch === null ? null : summary.endEpoch) as unknown as string | null,
        days: summary.days,
        total_gain: summary.totalGain as unknown as string,
        realized_gain: summary.realizedGain as unknown as string,
        unrealized_gain: summary.unrealizedGain as unknown as string,
        passive_gain: summary.passiveGain as unknown as string,
        fees_and_commissions: summary.feesAndCommissions as unknown as string,
        yield: summary.yield as unknown as string,
        annualized_yield_linear: summary.annualizedYieldLinear as unknown as string,
        annualized_yield_cagr: summary.annualizedYieldCagr as unknown as string,
        sub_trade_wins: summary.subTradeWins,
        sub_trade_losses: summary.subTradeLosses,
        sub_trade_breakevens: summary.subTradeBreakevens,
        sub_trade_win_rate: (summary.subTradeWinRate === null ? null : summary.subTradeWinRate) as unknown as string | null,
        sub_trade_win_amount: summary.subTradeWinAmount as unknown as string,
        sub_trade_loss_amount: summary.subTradeLossAmount as unknown as string,
        price_source: summary.priceSource ?? null,
        closing_date: (summary.closingDate ?? null) as unknown as Date | null,
        computed_at: summary.computedAt as unknown as string,
        explanation: summary.explanation ?? null,
        price_coverage: (summary.priceCoverage ?? null) as unknown as string | null,
        recompute_attempts: summary.recomputeAttempts ?? null,
        started_by: provenance.startedBy,
        job_id: provenance.jobId,
        writer: provenance.writerLambda,
        writer_version: provenance.writerVersion,
        written_at: provenance.writtenAt as unknown as string,
        created_by: owner,
        updated_by: owner,
      })
        .onConflict(oc => oc.columns(['owner', 'trade_id']).doUpdateSet(eb => ({
          peak_simultaneous_car: eb.ref('excluded.peak_simultaneous_car'),
          start_epoch: eb.ref('excluded.start_epoch'),
          end_epoch: eb.ref('excluded.end_epoch'),
          days: eb.ref('excluded.days'),
          total_gain: eb.ref('excluded.total_gain'),
          realized_gain: eb.ref('excluded.realized_gain'),
          unrealized_gain: eb.ref('excluded.unrealized_gain'),
          passive_gain: eb.ref('excluded.passive_gain'),
          fees_and_commissions: eb.ref('excluded.fees_and_commissions'),
          yield: eb.ref('excluded.yield'),
          annualized_yield_linear: eb.ref('excluded.annualized_yield_linear'),
          annualized_yield_cagr: eb.ref('excluded.annualized_yield_cagr'),
          sub_trade_wins: eb.ref('excluded.sub_trade_wins'),
          sub_trade_losses: eb.ref('excluded.sub_trade_losses'),
          sub_trade_breakevens: eb.ref('excluded.sub_trade_breakevens'),
          sub_trade_win_rate: eb.ref('excluded.sub_trade_win_rate'),
          sub_trade_win_amount: eb.ref('excluded.sub_trade_win_amount'),
          sub_trade_loss_amount: eb.ref('excluded.sub_trade_loss_amount'),
          price_source: eb.ref('excluded.price_source'),
          closing_date: eb.ref('excluded.closing_date'),
          computed_at: eb.ref('excluded.computed_at'),
          explanation: eb.ref('excluded.explanation'),
          price_coverage: eb.ref('excluded.price_coverage'),
          recompute_attempts: eb.ref('excluded.recompute_attempts'),
          started_by: eb.ref('excluded.started_by'),
          job_id: eb.ref('excluded.job_id'),
          writer: eb.ref('excluded.writer'),
          writer_version: eb.ref('excluded.writer_version'),
          written_at: eb.ref('excluded.written_at'),
          updated_by: eb.ref('excluded.updated_by'),
        })))
        .execute();
      log.info(`putOpenTradeSummary: tradeUuid=${summary.tradeUuid} segments=${segmentRows.length} units=${unitRows.length} startedBy=${provenance.startedBy}`);
    } catch (err) {
      // OrphanTradeError is a control-flow signal (trade deleted out from under
      // an in-flight reconstitution), not an infrastructure error. It must
      // survive unwrapped so the caller's isOrphanTradeError() benign-skip guard
      // fires — logAndEnhanceError would re-wrap it as a plain EnhancedError
      // (name 'Error'), defeating the guard. Mirrors the PauseRetryError
      // pass-through convention.
      if (isOrphanTradeError(err)) throw err;
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /**
   * Composite read: summary row + segments + units for one open trade, projected
   * to the public `TradeYieldSegmentSummary` wire shape. Returns undefined when
   * no summary row exists.
   */
  async getOpenTradeSummary(tradeUuid: TradeUUID): Promise<TradeYieldSegmentSummary | undefined> {
    const log = this.#log.setMethod('getOpenTradeSummary');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      const row = await this.#openSummaryRow(owner, tradeUuid);
      if (!row) return undefined;
      const [segments, units] = await Promise.all([
        this.getSegmentRowsForTradeAndContext(tradeUuid, OPEN_CONTEXT).then(rs => rs.map(toTradeYieldSegment)),
        this.getSubTradeYieldUnitRowsForTradeAndContext(tradeUuid, OPEN_CONTEXT).then(rs => rs.map(toSubTradeYieldUnit)),
      ]);
      return toOpenTradeYieldSummary(row, segments, units);
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /**
   * Return every open-trade summary scalar row for the session owner (no segment hydration).
   */
  async getAllOpenTradeSummaryRows(): Promise<_OpenTradeYieldSummary[]> {
    const log = this.#log.setMethod('getAllOpenTradeSummaryRows');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      const rows = await this.#db.selectFrom('open_trade_yield_summaries')
        .selectAll()
        .select(sql<string | null>`closing_date::text`.as('closing_date'))
        .where('owner', '=', owner)
        .execute();
      return rows.map(r => this.#openSummaryRowToRecord(r as OpenSummaryRow));
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /**
   * Admin helper (persistence-row-provenance.prd.md E10): return open-trade
   * summary rows whose provenance `writtenAt` is older than `cutoffEpoch` OR
   * whose `writtenAt` is missing (pre-PRD rows). Useful for staleness audits
   * and the audit-pipeline `excessive-staleness` check.
   */
  async findStaleOpenTradeSummaries(cutoffEpoch: number): Promise<_OpenTradeYieldSummary[]> {
    const log = this.#log.setMethod('findStaleOpenTradeSummaries');
    try {
      const all = await this.getAllOpenTradeSummaryRows();
      return all.filter(r => r.writtenAt === undefined || r.writtenAt === null || r.writtenAt < cutoffEpoch);
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /**
   * Admin helper (E10): aggregate open-trade summaries by a provenance attribute.
   * `groupBy` selects which attribute keys the result map. Returns a Map keyed by
   * the attribute value (or `'(unknown / pre-provenance)'` for rows missing it)
   * with `{count, sampleTradeUuids, firstWrittenAt, lastWrittenAt}` per group.
   */
  async groupOpenSummariesByProvenance(
    groupBy: 'writerLambda' | 'startedBy' | 'writerVersion',
  ): Promise<Map<string, {count: number; sampleTradeUuids: TradeUUID[]; firstWrittenAt: number | null; lastWrittenAt: number | null}>> {
    const log = this.#log.setMethod('groupOpenSummariesByProvenance');
    try {
      const all = await this.getAllOpenTradeSummaryRows();
      const groups = new Map<string, {count: number; sampleTradeUuids: TradeUUID[]; firstWrittenAt: number | null; lastWrittenAt: number | null}>();
      for (const r of all) {
        const key = (r as Partial<{writerLambda: string; startedBy: string; writerVersion: string}>)[groupBy] ?? '(unknown / pre-provenance)';
        let g = groups.get(key);
        if (!g) {
          g = {count: 0, sampleTradeUuids: [], firstWrittenAt: null, lastWrittenAt: null};
          groups.set(key, g);
        }
        g.count += 1;
        if (g.sampleTradeUuids.length < 3) g.sampleTradeUuids.push(r.tradeUuid);
        if (r.writtenAt !== undefined && r.writtenAt !== null) {
          if (g.firstWrittenAt === null || r.writtenAt < g.firstWrittenAt) g.firstWrittenAt = r.writtenAt;
          if (g.lastWrittenAt  === null || r.writtenAt > g.lastWrittenAt)  g.lastWrittenAt  = r.writtenAt;
        }
      }
      return groups;
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  // ── AS_OF summary I/O ───────────────────────────────────────────────────────

  /**
   * Atomic write of an as-of trade summary AND replacement of its fact rows for
   * the (trade, asOfDate) context. Mirrors `putOpenTradeSummary` but scoped to
   * one (trade, date) pair.
   *
   * Optional `existsCheck` mirrors the open-summary guard: throws
   * `OrphanTradeError` if the trade no longer exists in `financials.trades`,
   * persisting nothing.
   */
  async putAsOfTradeSummary(
    summary: AsOfTradeYieldSegmentSummary,
    provenance: Provenance,
    opts?: {existsCheck?: () => Promise<boolean>},
  ): Promise<void> {
    const log = this.#log.setMethod('putAsOfTradeSummary');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    const context = asOfContext(summary.asOfDate);
    try {
      if (opts?.existsCheck) {
        const exists = await opts.existsCheck();
        if (!exists) throw new OrphanTradeError(summary.tradeUuid, 'as-of');
      }
      await this.deleteFactRowsByTradeAndContext(summary.tradeUuid, context);

      const segmentRows = summary.segments.map(s => this.buildSegmentRow(context, s));
      const unitRows = summary.subTradeYieldUnits.map(u => this.buildSubTradeYieldUnitRow(context, u));
      if (segmentRows.length > 0) await this.putSegmentRows(segmentRows, provenance);
      if (unitRows.length > 0) await this.putSubTradeYieldUnitRows(unitRows, provenance);

      await this.#db.insertInto('as_of_trade_yield_summaries').values({
        owner,
        trade_id: summary.tradeUuid,
        as_of_date: summary.asOfDate as unknown as Date,
        as_of_epoch: summary.asOfEpoch as unknown as string,
        peak_simultaneous_car: summary.peakSimultaneousCaR as unknown as string,
        start_epoch: summary.startEpoch as unknown as string,
        end_epoch: (summary.endEpoch === null ? null : summary.endEpoch) as unknown as string | null,
        days: summary.days,
        total_gain: summary.totalGain as unknown as string,
        realized_gain: summary.realizedGain as unknown as string,
        unrealized_gain: summary.unrealizedGain as unknown as string,
        passive_gain: summary.passiveGain as unknown as string,
        fees_and_commissions: summary.feesAndCommissions as unknown as string,
        yield: summary.yield as unknown as string,
        annualized_yield_linear: summary.annualizedYieldLinear as unknown as string,
        annualized_yield_cagr: summary.annualizedYieldCagr as unknown as string,
        sub_trade_wins: summary.subTradeWins,
        sub_trade_losses: summary.subTradeLosses,
        sub_trade_breakevens: summary.subTradeBreakevens,
        sub_trade_win_rate: (summary.subTradeWinRate === null ? null : summary.subTradeWinRate) as unknown as string | null,
        sub_trade_win_amount: summary.subTradeWinAmount as unknown as string,
        sub_trade_loss_amount: summary.subTradeLossAmount as unknown as string,
        price_coverage: summary.priceCoverage as unknown as string,
        error: summary.error ?? null,
        price_source: summary.priceSource ?? null,
        closing_date: (summary.closingDate ?? null) as unknown as Date | null,
        explanation: summary.explanation ?? null,
        computed_at: summary.computedAt as unknown as string,
        started_by: provenance.startedBy,
        job_id: provenance.jobId,
        writer: provenance.writerLambda,
        writer_version: provenance.writerVersion,
        written_at: provenance.writtenAt as unknown as string,
        created_by: owner,
        updated_by: owner,
      })
        .onConflict(oc => oc.columns(['owner', 'trade_id', 'as_of_date']).doUpdateSet(eb => ({
          as_of_epoch: eb.ref('excluded.as_of_epoch'),
          peak_simultaneous_car: eb.ref('excluded.peak_simultaneous_car'),
          start_epoch: eb.ref('excluded.start_epoch'),
          end_epoch: eb.ref('excluded.end_epoch'),
          days: eb.ref('excluded.days'),
          total_gain: eb.ref('excluded.total_gain'),
          realized_gain: eb.ref('excluded.realized_gain'),
          unrealized_gain: eb.ref('excluded.unrealized_gain'),
          passive_gain: eb.ref('excluded.passive_gain'),
          fees_and_commissions: eb.ref('excluded.fees_and_commissions'),
          yield: eb.ref('excluded.yield'),
          annualized_yield_linear: eb.ref('excluded.annualized_yield_linear'),
          annualized_yield_cagr: eb.ref('excluded.annualized_yield_cagr'),
          sub_trade_wins: eb.ref('excluded.sub_trade_wins'),
          sub_trade_losses: eb.ref('excluded.sub_trade_losses'),
          sub_trade_breakevens: eb.ref('excluded.sub_trade_breakevens'),
          sub_trade_win_rate: eb.ref('excluded.sub_trade_win_rate'),
          sub_trade_win_amount: eb.ref('excluded.sub_trade_win_amount'),
          sub_trade_loss_amount: eb.ref('excluded.sub_trade_loss_amount'),
          price_coverage: eb.ref('excluded.price_coverage'),
          error: eb.ref('excluded.error'),
          price_source: eb.ref('excluded.price_source'),
          closing_date: eb.ref('excluded.closing_date'),
          explanation: eb.ref('excluded.explanation'),
          computed_at: eb.ref('excluded.computed_at'),
          started_by: eb.ref('excluded.started_by'),
          job_id: eb.ref('excluded.job_id'),
          writer: eb.ref('excluded.writer'),
          writer_version: eb.ref('excluded.writer_version'),
          written_at: eb.ref('excluded.written_at'),
          updated_by: eb.ref('excluded.updated_by'),
        })))
        .execute();
      log.info(`putAsOfTradeSummary: tradeUuid=${summary.tradeUuid} asOfDate=${summary.asOfDate} segments=${segmentRows.length} units=${unitRows.length} startedBy=${provenance.startedBy}`);
    } catch (err) {
      if (isOrphanTradeError(err)) throw err;
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /**
   * Composite read of an as-of summary + its segments + units.
   */
  async getAsOfTradeSummary(tradeUuid: TradeUUID, asOfDate: Datestamp): Promise<AsOfTradeYieldSegmentSummary | undefined> {
    const log = this.#log.setMethod('getAsOfTradeSummary');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    const context = asOfContext(asOfDate);
    try {
      const row = await this.#db.selectFrom('as_of_trade_yield_summaries')
        .selectAll()
        .select(sql<string>`as_of_date::text`.as('as_of_date'))
        .select(sql<string | null>`closing_date::text`.as('closing_date'))
        .where('owner', '=', owner)
        .where('trade_id', '=', tradeUuid)
        .where('as_of_date', '=', asOfDate as unknown as Date)
        .executeTakeFirst();
      if (!row) return undefined;
      const record = asOfSummaryRowToRecord(row as AsOfSummaryRow);
      const [segments, units] = await Promise.all([
        this.getSegmentRowsForTradeAndContext(tradeUuid, context).then(rs => rs.map(toTradeYieldSegment)),
        this.getSubTradeYieldUnitRowsForTradeAndContext(tradeUuid, context).then(rs => rs.map(toSubTradeYieldUnit)),
      ]);
      return toAsOfTradeYieldSummary(record, segments, units);
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /**
   * Every as-of summary row for one trade across dates (no segment hydration).
   * Optional inclusive `range` filters by as_of_date.
   */
  async getAsOfTradeSummaryRowsForTrade(tradeUuid: TradeUUID, range?: DateRange): Promise<_AsOfTradeYieldSummary[]> {
    const log = this.#log.setMethod('getAsOfTradeSummaryRowsForTrade');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      let q = this.#db.selectFrom('as_of_trade_yield_summaries')
        .selectAll()
        .select(sql<string>`as_of_date::text`.as('as_of_date'))
        .select(sql<string | null>`closing_date::text`.as('closing_date'))
        .where('owner', '=', owner)
        .where('trade_id', '=', tradeUuid);
      if (range?.from) q = q.where('as_of_date', '>=', range.from as unknown as Date);
      if (range?.to) q = q.where('as_of_date', '<=', range.to as unknown as Date);
      const rows = await q.execute();
      return rows.map(r => asOfSummaryRowToRecord(r as AsOfSummaryRow));
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /**
   * Every as-of summary row for one owner on one asOfDate (no segment hydration).
   * Uses the (owner, as_of_date) index.
   */
  async getAsOfTradeSummaryRowsForOwnerAndDate(asOfDate: Datestamp): Promise<_AsOfTradeYieldSummary[]> {
    const log = this.#log.setMethod('getAsOfTradeSummaryRowsForOwnerAndDate');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      const rows = await this.#db.selectFrom('as_of_trade_yield_summaries')
        .selectAll()
        .select(sql<string>`as_of_date::text`.as('as_of_date'))
        .select(sql<string | null>`closing_date::text`.as('closing_date'))
        .where('owner', '=', owner)
        .where('as_of_date', '=', asOfDate as unknown as Date)
        .execute();
      return rows.map(r => asOfSummaryRowToRecord(r as AsOfSummaryRow));
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  // ── SINCE summary I/O ───────────────────────────────────────────────────────

  /**
   * Atomic write of a since-trade summary AND replacement of its fact rows for
   * the (trade, sinceAnchorEpoch) context.
   */
  async putSinceTradeSummary(
    summary: SinceTradeYieldSegmentSummary,
    provenance: Provenance,
  ): Promise<void> {
    const log = this.#log.setMethod('putSinceTradeSummary');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    const context = sinceContext(summary.sinceAnchorEpoch);
    try {
      await this.deleteFactRowsByTradeAndContext(summary.tradeUuid, context);

      const segmentRows = summary.segments.map(s => this.buildSegmentRow(context, s));
      const unitRows = summary.subTradeYieldUnits.map(u => this.buildSubTradeYieldUnitRow(context, u));
      if (segmentRows.length > 0) await this.putSegmentRows(segmentRows, provenance);
      if (unitRows.length > 0) await this.putSubTradeYieldUnitRows(unitRows, provenance);

      await this.#db.insertInto('since_trade_yield_summaries').values({
        owner,
        trade_id: summary.tradeUuid,
        since_anchor_epoch: summary.sinceAnchorEpoch as unknown as string,
        gain_since: summary.gainSince as unknown as string,
        peak_simultaneous_car: summary.peakSimultaneousCaR as unknown as string,
        start_epoch: summary.startEpoch as unknown as string,
        end_epoch: (summary.endEpoch === null ? null : summary.endEpoch) as unknown as string | null,
        days: summary.days,
        total_gain: summary.totalGain as unknown as string,
        realized_gain: summary.realizedGain as unknown as string,
        unrealized_gain: summary.unrealizedGain as unknown as string,
        passive_gain: summary.passiveGain as unknown as string,
        fees_and_commissions: summary.feesAndCommissions as unknown as string,
        yield: summary.yield as unknown as string,
        annualized_yield_linear: summary.annualizedYieldLinear as unknown as string,
        annualized_yield_cagr: summary.annualizedYieldCagr as unknown as string,
        sub_trade_wins: summary.subTradeWins,
        sub_trade_losses: summary.subTradeLosses,
        sub_trade_breakevens: summary.subTradeBreakevens,
        sub_trade_win_rate: (summary.subTradeWinRate === null ? null : summary.subTradeWinRate) as unknown as string | null,
        sub_trade_win_amount: summary.subTradeWinAmount as unknown as string,
        sub_trade_loss_amount: summary.subTradeLossAmount as unknown as string,
        price_source: summary.priceSource ?? null,
        closing_date: (summary.closingDate ?? null) as unknown as Date | null,
        explanation: summary.explanation ?? null,
        computed_at: summary.computedAt as unknown as string,
        started_by: provenance.startedBy,
        job_id: provenance.jobId,
        writer: provenance.writerLambda,
        writer_version: provenance.writerVersion,
        written_at: provenance.writtenAt as unknown as string,
        created_by: owner,
        updated_by: owner,
      })
        .onConflict(oc => oc.columns(['owner', 'trade_id', 'since_anchor_epoch']).doUpdateSet(eb => ({
          gain_since: eb.ref('excluded.gain_since'),
          peak_simultaneous_car: eb.ref('excluded.peak_simultaneous_car'),
          start_epoch: eb.ref('excluded.start_epoch'),
          end_epoch: eb.ref('excluded.end_epoch'),
          days: eb.ref('excluded.days'),
          total_gain: eb.ref('excluded.total_gain'),
          realized_gain: eb.ref('excluded.realized_gain'),
          unrealized_gain: eb.ref('excluded.unrealized_gain'),
          passive_gain: eb.ref('excluded.passive_gain'),
          fees_and_commissions: eb.ref('excluded.fees_and_commissions'),
          yield: eb.ref('excluded.yield'),
          annualized_yield_linear: eb.ref('excluded.annualized_yield_linear'),
          annualized_yield_cagr: eb.ref('excluded.annualized_yield_cagr'),
          sub_trade_wins: eb.ref('excluded.sub_trade_wins'),
          sub_trade_losses: eb.ref('excluded.sub_trade_losses'),
          sub_trade_breakevens: eb.ref('excluded.sub_trade_breakevens'),
          sub_trade_win_rate: eb.ref('excluded.sub_trade_win_rate'),
          sub_trade_win_amount: eb.ref('excluded.sub_trade_win_amount'),
          sub_trade_loss_amount: eb.ref('excluded.sub_trade_loss_amount'),
          price_source: eb.ref('excluded.price_source'),
          closing_date: eb.ref('excluded.closing_date'),
          explanation: eb.ref('excluded.explanation'),
          computed_at: eb.ref('excluded.computed_at'),
          started_by: eb.ref('excluded.started_by'),
          job_id: eb.ref('excluded.job_id'),
          writer: eb.ref('excluded.writer'),
          writer_version: eb.ref('excluded.writer_version'),
          written_at: eb.ref('excluded.written_at'),
          updated_by: eb.ref('excluded.updated_by'),
        })))
        .execute();
      log.info(`putSinceTradeSummary: tradeUuid=${summary.tradeUuid} anchor=${summary.sinceAnchorEpoch} startedBy=${provenance.startedBy}`);
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /**
   * Composite read of a since-summary + its segments + units.
   */
  async getSinceTradeSummary(tradeUuid: TradeUUID, sinceAnchorEpoch: number): Promise<SinceTradeYieldSegmentSummary | undefined> {
    const log = this.#log.setMethod('getSinceTradeSummary');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    const context = sinceContext(sinceAnchorEpoch);
    try {
      const row = await this.#db.selectFrom('since_trade_yield_summaries')
        .selectAll()
        .select(sql<string | null>`closing_date::text`.as('closing_date'))
        .where('owner', '=', owner)
        .where('trade_id', '=', tradeUuid)
        .where('since_anchor_epoch', '=', sinceAnchorEpoch as unknown as string)
        .executeTakeFirst();
      if (!row) return undefined;
      const record = sinceSummaryRowToRecord(row as SinceSummaryRow);
      const [segments, units] = await Promise.all([
        this.getSegmentRowsForTradeAndContext(tradeUuid, context).then(rs => rs.map(toTradeYieldSegment)),
        this.getSubTradeYieldUnitRowsForTradeAndContext(tradeUuid, context).then(rs => rs.map(toSubTradeYieldUnit)),
      ]);
      return toSinceTradeYieldSummary(record, segments, units);
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /**
   * Every since-summary row for one trade across anchors (no segment hydration).
   */
  async getSinceTradeSummaryRowsForTrade(tradeUuid: TradeUUID): Promise<_SinceTradeYieldSummary[]> {
    const log = this.#log.setMethod('getSinceTradeSummaryRowsForTrade');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      const rows = await this.#db.selectFrom('since_trade_yield_summaries')
        .selectAll()
        .select(sql<string | null>`closing_date::text`.as('closing_date'))
        .where('owner', '=', owner)
        .where('trade_id', '=', tradeUuid)
        .execute();
      return rows.map(r => sinceSummaryRowToRecord(r as SinceSummaryRow));
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  // ── Daily MTM series I/O (E11.5) ────────────────────────────────────────────

  /**
   * Idempotent batch put of daily MTM rows. Inserts each row into
   * `trade_daily_mtm_series` AND its `segmentArchetypeContributions[]` into the
   * child `trade_daily_mtm_archetype_contributions` table. Same-key writes
   * overwrite (upsert) — the populator is allowed to recompute and re-put any
   * date without first deleting.
   *
   * NOTE: provenance is accepted for parity with the other put methods, but the
   * `trade_daily_mtm_series` table has no provenance columns (none in the 4a DDL),
   * so it is not persisted.
   */
  async putDailyMTMRows(rows: _TradeDailyMTMSeries[], provenance: Provenance): Promise<void> {
    const log = this.#log.setMethod('putDailyMTMRows');
    if (rows.length === 0) return;
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      for (const r of rows) {
        await this.#db.insertInto('trade_daily_mtm_series').values({
          owner,
          trade_id: r.tradeUuid,
          date_epoch: r.dateEpoch as unknown as string,
          date: r.date as unknown as Date,
          mtm_amount: r.mtmAmount as unknown as string,
          car_at_date: r.carAtDate as unknown as string,
          price_coverage: r.priceCoverage as unknown as string,
          computed_at: r.computedAt as unknown as string,
          created_by: owner,
          updated_by: owner,
        })
          .onConflict(oc => oc.columns(['owner', 'trade_id', 'date_epoch']).doUpdateSet(eb => ({
            date: eb.ref('excluded.date'),
            mtm_amount: eb.ref('excluded.mtm_amount'),
            car_at_date: eb.ref('excluded.car_at_date'),
            price_coverage: eb.ref('excluded.price_coverage'),
            computed_at: eb.ref('excluded.computed_at'),
            updated_by: eb.ref('excluded.updated_by'),
          })))
          .execute();

        // Replace the bounded archetype-contribution children for this (owner, trade, date).
        await this.#db.deleteFrom('trade_daily_mtm_archetype_contributions')
          .where('owner', '=', owner)
          .where('trade_id', '=', r.tradeUuid)
          .where('date_epoch', '=', r.dateEpoch as unknown as string)
          .execute();
        if (r.segmentArchetypeContributions.length > 0) {
          await this.#db.insertInto('trade_daily_mtm_archetype_contributions').values(
            r.segmentArchetypeContributions.map(c => ({
              owner,
              trade_id: r.tradeUuid,
              date_epoch: r.dateEpoch as unknown as string,
              archetype: c.archetype,
              car_contribution: c.carContribution as unknown as string,
              created_by: owner,
            })),
          ).execute();
        }
      }
      log.info(`putDailyMTMRows: wrote ${rows.length} rows startedBy=${provenance.startedBy}`);
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /**
   * All daily-MTM rows for one trade, ordered ascending by date. Empty array (NOT
   * undefined) when the populator hasn't run for this trade yet — callers use that
   * signal to decide whether to enqueue the populator.
   */
  async queryDailyMTMSeriesForTrade(tradeUuid: TradeUUID): Promise<_TradeDailyMTMSeries[]> {
    const log = this.#log.setMethod('queryDailyMTMSeriesForTrade');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      const rows = await this.#db.selectFrom('trade_daily_mtm_series')
        .selectAll()
        .select(sql<string>`date::text`.as('date'))
        .where('owner', '=', owner)
        .where('trade_id', '=', tradeUuid)
        .orderBy('date_epoch', 'asc')
        .execute();
      if (rows.length === 0) return [];
      const contribRows = await this.#db.selectFrom('trade_daily_mtm_archetype_contributions').selectAll()
        .where('owner', '=', owner)
        .where('trade_id', '=', tradeUuid)
        .execute();
      const byDate = new Map<string, typeof contribRows>();
      for (const c of contribRows) {
        const arr = byDate.get(c.date_epoch);
        if (arr) arr.push(c);
        else byDate.set(c.date_epoch, [c]);
      }
      return rows.map(r => dailyMtmRowToRecord(r as DailyMtmRow, byDate.get(r.date_epoch) ?? []));
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /**
   * Emergent watchlist for the nightly tail-extender: distinct `tradeUuid`
   * values for the session owner.
   */
  async getDistinctTradeUuidsWithDailyMTM(): Promise<TradeUUID[]> {
    const log = this.#log.setMethod('getDistinctTradeUuidsWithDailyMTM');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      const rows = await this.#db.selectFrom('trade_daily_mtm_series')
        .select('trade_id')
        .distinct()
        .where('owner', '=', owner)
        .execute();
      return rows.map(r => r.trade_id as TradeUUID);
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /**
   * Delete every daily-MTM row for one trade (the archetype-contribution children
   * cascade via FK). Used by trade-deletion + yield-math invalidation.
   */
  async deleteDailyMTMSeriesForTrade(tradeUuid: TradeUUID): Promise<number> {
    const log = this.#log.setMethod('deleteDailyMTMSeriesForTrade');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      const res = await this.#db.deleteFrom('trade_daily_mtm_series')
        .where('owner', '=', owner)
        .where('trade_id', '=', tradeUuid)
        .executeTakeFirst();
      const count = Number(res.numDeletedRows ?? 0n);
      log.info(`deleteDailyMTMSeriesForTrade: tradeUuid=${tradeUuid} count=${count}`);
      return count;
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  // ── Cascade-delete ──────────────────────────────────────────────────────────

  /**
   * Hard delete of every persistence-layer artifact for one trade — all summary
   * rows (open + every as-of + every since) AND every segment + sub-trade-unit
   * fact row in every context, plus the daily-MTM series. Used by
   * `trade-deletion-orchestrator` and by the trade-uuid rotation path.
   *
   * Returns `{deleted, asOfDatesTouched}`. The caller is expected to chain a
   * cascade-delete of the AS_OF_*_GAINS rows for the touched dates via
   * `GainSnapshotsTrustedApi.deleteAsOfRowsForDates(asOfDatesTouched)`.
   *
   * NOTE: although the yield tables FK trades(trade_id) ON DELETE CASCADE, this
   * method deletes explicitly (the domain calls it for invalidation without
   * deleting the trade row) and returns the same counts/shape as the DDB version.
   * Segment portion + archetype-contribution children cascade via their own FKs.
   */
  async deleteByTrade(tradeUuid: TradeUUID): Promise<{deleted: number; asOfDatesTouched: Datestamp[]}> {
    const log = this.#log.setMethod('deleteByTrade');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    const _t = Date.now();
    try {
      // Collect the as-of dates touched before deleting (for the caller's gain cascade).
      const asOfDateRows = await this.#db.selectFrom('as_of_trade_yield_summaries')
        .select(sql<string>`as_of_date::text`.as('as_of_date'))
        .where('owner', '=', owner)
        .where('trade_id', '=', tradeUuid)
        .execute();
      const asOfDatesTouched = [...new Set(asOfDateRows.map(r => r.as_of_date as Datestamp))];

      let total = 0;
      // Segments (their transaction-portion children cascade via FK).
      const segDel = await this.#db.deleteFrom('trade_yield_segments')
        .where('owner', '=', owner).where('trade_id', '=', tradeUuid).executeTakeFirst();
      total += Number(segDel.numDeletedRows ?? 0n);
      const unitDel = await this.#db.deleteFrom('sub_trade_yield_units')
        .where('owner', '=', owner).where('trade_id', '=', tradeUuid).executeTakeFirst();
      total += Number(unitDel.numDeletedRows ?? 0n);
      const openDel = await this.#db.deleteFrom('open_trade_yield_summaries')
        .where('owner', '=', owner).where('trade_id', '=', tradeUuid).executeTakeFirst();
      total += Number(openDel.numDeletedRows ?? 0n);
      const asOfDel = await this.#db.deleteFrom('as_of_trade_yield_summaries')
        .where('owner', '=', owner).where('trade_id', '=', tradeUuid).executeTakeFirst();
      total += Number(asOfDel.numDeletedRows ?? 0n);
      const sinceDel = await this.#db.deleteFrom('since_trade_yield_summaries')
        .where('owner', '=', owner).where('trade_id', '=', tradeUuid).executeTakeFirst();
      total += Number(sinceDel.numDeletedRows ?? 0n);
      // Daily-MTM series (archetype-contribution children cascade via FK).
      const mtmDel = await this.#db.deleteFrom('trade_daily_mtm_series')
        .where('owner', '=', owner).where('trade_id', '=', tradeUuid).executeTakeFirst();
      total += Number(mtmDel.numDeletedRows ?? 0n);

      log.timing(`[trace:trade-yield-persistence] deleteByTrade: ${Date.now() - _t}ms | tradeUuid=${tradeUuid} total=${total} asOfDatesTouched=${asOfDatesTouched.length}`);
      return {deleted: total, asOfDatesTouched};
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /**
   * Delete fact rows (segments + units) for one (trade, context). Used by the
   * summary write path to replace the prior context's facts. Does NOT touch
   * summary rows. Segment transaction-portion children cascade via FK.
   */
  async deleteFactRowsByTradeAndContext(tradeUuid: TradeUUID, context: YieldContext): Promise<number> {
    const log = this.#log.setMethod('deleteFactRowsByTradeAndContext');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      let total = 0;
      const segDel = await this.#db.deleteFrom('trade_yield_segments')
        .where('owner', '=', owner).where('trade_id', '=', tradeUuid).where('context', '=', context).executeTakeFirst();
      total += Number(segDel.numDeletedRows ?? 0n);
      const unitDel = await this.#db.deleteFrom('sub_trade_yield_units')
        .where('owner', '=', owner).where('trade_id', '=', tradeUuid).where('context', '=', context).executeTakeFirst();
      total += Number(unitDel.numDeletedRows ?? 0n);
      log.info(`deleteFactRowsByTradeAndContext: tradeUuid=${tradeUuid} context=${context} total=${total}`);
      return total;
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /**
   * Delete the open-context fact rows + summary row for one trade.
   */
  async deleteOpenTradeRowsByTrade(tradeUuid: TradeUUID): Promise<number> {
    const log = this.#log.setMethod('deleteOpenTradeRowsByTrade');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      const factCount = await this.deleteFactRowsByTradeAndContext(tradeUuid, OPEN_CONTEXT);
      const openDel = await this.#db.deleteFrom('open_trade_yield_summaries')
        .where('owner', '=', owner).where('trade_id', '=', tradeUuid).executeTakeFirst();
      const summaryCount = Number(openDel.numDeletedRows ?? 0n);
      log.info(`deleteOpenTradeRowsByTrade: tradeUuid=${tradeUuid} facts=${factCount} summary=${summaryCount}`);
      return factCount + summaryCount;
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /**
   * Historical-yield-invalidation cleanup: delete every as-of summary row for one
   * trade where `asOfDate >= fromDate`, plus the matching fact rows for each.
   * Idempotent.
   */
  async deleteAsOfSummariesByTradeAndDateRange(tradeUuid: TradeUUID, fromDate: Datestamp): Promise<number> {
    const log = this.#log.setMethod('deleteAsOfSummariesByTradeAndDateRange');
    try {
      const rows = await this.getAsOfTradeSummaryRowsForTrade(tradeUuid, {from: fromDate});
      if (rows.length === 0) return 0;
      let factCount = 0;
      for (const row of rows) {
        factCount += await this.deleteFactRowsByTradeAndContext(tradeUuid, asOfContext(row.asOfDate));
      }
      const owner = getSessionOwner(this.ec) as AccountOwner;
      const del = await this.#db.deleteFrom('as_of_trade_yield_summaries')
        .where('owner', '=', owner)
        .where('trade_id', '=', tradeUuid)
        .where('as_of_date', '>=', fromDate as unknown as Date)
        .executeTakeFirst();
      const summaryCount = Number(del.numDeletedRows ?? 0n);
      log.info(`deleteAsOfSummariesByTradeAndDateRange: tradeUuid=${tradeUuid} fromDate=${fromDate} summaries=${summaryCount} facts=${factCount}`);
      return summaryCount + factCount;
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /**
   * Historical-yield-invalidation cleanup: delete every since summary row for one
   * trade where `sinceAnchorEpoch >= fromEpoch`, plus the matching fact rows.
   * Idempotent.
   */
  async deleteSinceSummariesByTradeAndAnchorRange(tradeUuid: TradeUUID, fromEpoch: number): Promise<number> {
    const log = this.#log.setMethod('deleteSinceSummariesByTradeAndAnchorRange');
    try {
      const rows = await this.getSinceTradeSummaryRowsForTrade(tradeUuid);
      const affected = rows.filter(r => r.sinceAnchorEpoch >= fromEpoch);
      if (affected.length === 0) return 0;
      let factCount = 0;
      for (const row of affected) {
        factCount += await this.deleteFactRowsByTradeAndContext(tradeUuid, sinceContext(row.sinceAnchorEpoch));
      }
      const owner = getSessionOwner(this.ec) as AccountOwner;
      const del = await this.#db.deleteFrom('since_trade_yield_summaries')
        .where('owner', '=', owner)
        .where('trade_id', '=', tradeUuid)
        .where('since_anchor_epoch', '>=', fromEpoch as unknown as string)
        .executeTakeFirst();
      const summaryCount = Number(del.numDeletedRows ?? 0n);
      log.info(`deleteSinceSummariesByTradeAndAnchorRange: tradeUuid=${tradeUuid} fromEpoch=${fromEpoch} summaries=${summaryCount} facts=${factCount}`);
      return summaryCount + factCount;
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  async #openSummaryRow(owner: AccountOwner, tradeUuid: TradeUUID): Promise<_OpenTradeYieldSummary | undefined> {
    const row = await this.#db.selectFrom('open_trade_yield_summaries')
      .selectAll()
      .select(sql<string | null>`closing_date::text`.as('closing_date'))
      .where('owner', '=', owner)
      .where('trade_id', '=', tradeUuid)
      .executeTakeFirst();
    if (!row) return undefined;
    return this.#openSummaryRowToRecord(row as OpenSummaryRow);
  }

  #openSummaryRowToRecord(row: OpenSummaryRow): _OpenTradeYieldSummary {
    const record: _OpenTradeYieldSummary = {
      owner: row.owner as AccountOwner,
      tradeUuid: row.trade_id as TradeUUID,
      peakSimultaneousCaR: Number(row.peak_simultaneous_car),
      startEpoch: Number(row.start_epoch),
      endEpoch: row.end_epoch === null ? null : Number(row.end_epoch),
      days: row.days,
      totalGain: Number(row.total_gain),
      realizedGain: Number(row.realized_gain),
      unrealizedGain: Number(row.unrealized_gain),
      passiveGain: Number(row.passive_gain),
      feesAndCommissions: Number(row.fees_and_commissions),
      yield: Number(row.yield),
      annualizedYieldLinear: Number(row.annualized_yield_linear),
      annualizedYieldCagr: Number(row.annualized_yield_cagr),
      subTradeWins: row.sub_trade_wins,
      subTradeLosses: row.sub_trade_losses,
      subTradeBreakevens: row.sub_trade_breakevens,
      subTradeWinRate: row.sub_trade_win_rate === null ? null : Number(row.sub_trade_win_rate),
      subTradeWinAmount: Number(row.sub_trade_win_amount),
      subTradeLossAmount: Number(row.sub_trade_loss_amount),
      computedAt: Number(row.computed_at),
    };
    if (row.price_source !== null) record.priceSource = row.price_source as 'realtime' | 'most-recent-close';
    if (row.closing_date !== null) record.closingDate = row.closing_date as Datestamp;
    if (row.explanation !== null) record.explanation = row.explanation;
    if (row.price_coverage !== null) record.priceCoverage = Number(row.price_coverage);
    if (row.recompute_attempts !== null) record.recomputeAttempts = row.recompute_attempts;
    if (row.started_by !== null) record.startedBy = row.started_by;
    if (row.job_id !== null) record.jobId = row.job_id;
    if (row.writer !== null) record.writerLambda = row.writer;
    if (row.writer_version !== null) record.writerVersion = row.writer_version;
    if (row.written_at !== null) record.writtenAt = Number(row.written_at);
    return record;
  }
}

/** Open-summary SELECT row with `closing_date` projected to a 'YYYY-MM-DD' string via `::text`. */
type OpenSummaryRow = Omit<Selectable<OpenTradeYieldSummariesTable>, 'closing_date'> & {closing_date: string | null};

// Re-exports for consumer convenience.
export {
  OPEN_CONTEXT,
  asOfContext,
  sinceContext,
  padEpoch,
};
