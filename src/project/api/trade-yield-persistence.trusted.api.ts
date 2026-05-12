/*
Created by Franz Zemen 05/11/2026
License Type: UNLICENSED
*/

import {Dynamo, KeyStructuredExpression} from '@franzzemen/aws-app/dynamo';
import {EndpointApplicationsApi, getSessionOwner} from '@franzzemen/endpoint-application';
import {AccountOwner} from '@franzzemen/endpoint-financial-identity';
import {logAndEnhanceError} from '@franzzemen/enhanced-error';
import {ExecutionContext} from '@franzzemen/execution-context';
import {
  AsOfTradeYieldSegmentSummary,
  SinceTradeYieldSegmentSummary,
  SubTradeYieldUnit,
  SubTradeYieldUnitUUID,
  TradeUUID,
  TradeYieldSegment,
  TradeYieldSegmentSummary,
  TradeYieldSegmentUUID,
} from '@franzzemen/financial-identity';
import {LoggerApi} from '@franzzemen/logger';
import {Datestamp} from '@franzzemen/utility';

import {
  AS_OF_TRADE_YIELD_SUMMARIES,
  BY_TRADE_INDEX,
  OPEN_TRADE_YIELD_SUMMARIES,
  SINCE_TRADE_YIELD_SUMMARIES,
  SUB_TRADE_YIELD_UNITS,
  TRADE_YIELD_SEGMENTS,
} from '../schema/trade-yield-persistence-schema.js';
import {
  _SubTradeYieldUnit,
  makeContextTradeSubTradeUnitSk,
  makeTradeContextSubTradeUnitSk,
  toSubTradeYieldUnit,
} from '../identity/_sub-trade-yield-unit.js';
import {
  _TradeYieldSegment,
  makeContextTradeStartSk,
  makeTradeContextStartSk,
  toTradeYieldSegment,
} from '../identity/_trade-yield-segment.js';
import {
  _OpenTradeYieldSummary,
  toOpenTradeYieldSummary,
} from '../identity/_open-trade-yield-summary.js';
import {
  _AsOfTradeYieldSummary,
  makeAsOfDateTradeUuidSk,
  makeTradeUuidAsOfDateSk,
  toAsOfTradeYieldSummary,
} from '../identity/_as-of-trade-yield-summary.js';
import {
  _SinceTradeYieldSummary,
  makeSinceAnchorTradeUuidSk,
  makeTradeUuidSinceAnchorSk,
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
 * five trade-yield-segment persistence tables (yield-segment-redesign PRD E8).
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
export class TradeYieldPersistenceTrustedApi extends EndpointApplicationsApi {
  #log: LoggerApi;
  #dynamo: Dynamo;

  constructor(ec: ExecutionContext) {
    super(ec);
    this.#log = new LoggerApi(ec, 'trade-yield-persistence', 'trade-yield-persistence.trusted.api', TradeYieldPersistenceTrustedApi.name);
    this.#dynamo = new Dynamo(ec, 'dynamodb-user');
  }

  // ── Fact-row writes ─────────────────────────────────────────────────────────

  /**
   * Batch-put per-segment fact rows. Caller is responsible for populating the
   * row's `contextTradeStartSk` and `tradeContextStartSk` via the helpers
   * exposed here (`buildSegmentRow`).
   */
  async putSegmentRows(rows: _TradeYieldSegment[]): Promise<void> {
    const log = this.#log.setMethod('putSegmentRows');
    if (rows.length === 0) return;
    try {
      await this.#dynamo.batchPut({[TRADE_YIELD_SEGMENTS]: rows});
      log.info(`putSegmentRows: wrote ${rows.length} rows`);
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /** Batch-put per-sub-trade-yield-unit fact rows. */
  async putSubTradeYieldUnitRows(rows: _SubTradeYieldUnit[]): Promise<void> {
    const log = this.#log.setMethod('putSubTradeYieldUnitRows');
    if (rows.length === 0) return;
    try {
      await this.#dynamo.batchPut({[SUB_TRADE_YIELD_UNITS]: rows});
      log.info(`putSubTradeYieldUnitRows: wrote ${rows.length} rows`);
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /**
   * Convenience constructor for a `_TradeYieldSegment` row from a (context, segment) pair.
   * Used by callers that want to compute the SK strings once and persist the row directly.
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
      contextTradeStartSk: makeContextTradeStartSk(context, segment.tradeUuid, segment.startEpoch, segment.uuid),
      tradeContextStartSk: makeTradeContextStartSk(segment.tradeUuid, context, segment.startEpoch, segment.uuid),
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
      contextTradeSubTradeUnitSk: makeContextTradeSubTradeUnitSk(context, unit.tradeUuid, unit.subTradeUuid, unit.uuid),
      tradeContextSubTradeUnitSk: makeTradeContextSubTradeUnitSk(unit.tradeUuid, context, unit.subTradeUuid, unit.uuid),
    };
  }

  // ── Fact-row queries ────────────────────────────────────────────────────────

  /**
   * Return every segment fact row for one (trade, context) — the input to summary
   * hydration on read. Single LSI Query with `${tradeUuid}#${context}#` prefix.
   */
  async getSegmentRowsForTradeAndContext(tradeUuid: TradeUUID, context: YieldContext): Promise<_TradeYieldSegment[]> {
    const log = this.#log.setMethod('getSegmentRowsForTradeAndContext');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      const keyExpr: KeyStructuredExpression = {
        partitionFieldName: 'owner',
        operator: '=',
        value: owner,
        sortFieldName: 'tradeContextStartSk',
        sortOperator: 'begins_with',
        sortValue: `${tradeUuid}#${context}#`,
      };
      return await this.#dynamo.query<_TradeYieldSegment>(TRADE_YIELD_SEGMENTS, BY_TRADE_INDEX, keyExpr);
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /** Return every sub-trade-yield-unit fact row for one (trade, context). */
  async getSubTradeYieldUnitRowsForTradeAndContext(tradeUuid: TradeUUID, context: YieldContext): Promise<_SubTradeYieldUnit[]> {
    const log = this.#log.setMethod('getSubTradeYieldUnitRowsForTradeAndContext');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      const keyExpr: KeyStructuredExpression = {
        partitionFieldName: 'owner',
        operator: '=',
        value: owner,
        sortFieldName: 'tradeContextSubTradeUnitSk',
        sortOperator: 'begins_with',
        sortValue: `${tradeUuid}#${context}#`,
      };
      return await this.#dynamo.query<_SubTradeYieldUnit>(SUB_TRADE_YIELD_UNITS, BY_TRADE_INDEX, keyExpr);
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  // ── OPEN summary I/O ────────────────────────────────────────────────────────

  /**
   * Atomic write of an open-trade summary AND replacement of its fact rows.
   * Replaces ALL open-context segment + unit rows for the trade with the supplied
   * set, then puts the summary row. The supplied summary's segments / units must
   * have their `uuid` fields populated.
   */
  async putOpenTradeSummary(summary: TradeYieldSegmentSummary): Promise<void> {
    const log = this.#log.setMethod('putOpenTradeSummary');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      await this.deleteOpenTradeRowsByTrade(summary.tradeUuid);

      const segmentRows = summary.segments.map(s => this.buildSegmentRow(OPEN_CONTEXT, s));
      const unitRows = summary.subTradeYieldUnits.map(u => this.buildSubTradeYieldUnitRow(OPEN_CONTEXT, u));
      if (segmentRows.length > 0) await this.putSegmentRows(segmentRows);
      if (unitRows.length > 0) await this.putSubTradeYieldUnitRows(unitRows);

      const row: _OpenTradeYieldSummary = {
        owner,
        tradeUuid: summary.tradeUuid,
        peakSimultaneousCaR: summary.peakSimultaneousCaR,
        startEpoch: summary.startEpoch,
        endEpoch: summary.endEpoch,
        days: summary.days,
        totalGain: summary.totalGain,
        realizedGain: summary.realizedGain,
        unrealizedGain: summary.unrealizedGain,
        passiveGain: summary.passiveGain,
        feesAndCommissions: summary.feesAndCommissions,
        yield: summary.yield,
        annualizedYieldLinear: summary.annualizedYieldLinear,
        annualizedYieldCagr: summary.annualizedYieldCagr,
        segmentUuids: summary.segments.map(s => s.uuid!) as TradeYieldSegmentUUID[],
        subTradeYieldUnitUuids: summary.subTradeYieldUnits.map(u => u.uuid!) as SubTradeYieldUnitUUID[],
        computedAt: summary.computedAt,
      };
      if (summary.priceSource !== undefined) row.priceSource = summary.priceSource;
      if (summary.closingDate !== undefined) row.closingDate = summary.closingDate;
      if (summary.explanation !== undefined) row.explanation = summary.explanation;

      await this.#dynamo.batchPut({[OPEN_TRADE_YIELD_SUMMARIES]: [row]});
      log.info(`putOpenTradeSummary: tradeUuid=${summary.tradeUuid} segments=${segmentRows.length} units=${unitRows.length}`);
    } catch (err) {
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
      const row = await this.#dynamo.get<_OpenTradeYieldSummary>(OPEN_TRADE_YIELD_SUMMARIES, {owner, tradeUuid});
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

  /** Return every open-trade summary scalar row for the session owner (no segment hydration). */
  async getAllOpenTradeSummaryRows(): Promise<_OpenTradeYieldSummary[]> {
    const log = this.#log.setMethod('getAllOpenTradeSummaryRows');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      return await this.#dynamo.query<_OpenTradeYieldSummary>(
        OPEN_TRADE_YIELD_SUMMARIES, false,
        {partitionFieldName: 'owner', operator: '=', value: owner},
      );
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  // ── AS_OF summary I/O ───────────────────────────────────────────────────────

  /**
   * Atomic write of an as-of trade summary AND replacement of its fact rows for
   * the (trade, asOfDate) context. Mirrors `putOpenTradeSummary` but scoped to
   * one (trade, date) pair.
   */
  async putAsOfTradeSummary(
    summary: AsOfTradeYieldSegmentSummary,
    audit?: {startedBy?: string; jobId?: string},
  ): Promise<void> {
    const log = this.#log.setMethod('putAsOfTradeSummary');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    const context = asOfContext(summary.asOfDate);
    try {
      await this.deleteFactRowsByTradeAndContext(summary.tradeUuid, context);

      const segmentRows = summary.segments.map(s => this.buildSegmentRow(context, s));
      const unitRows = summary.subTradeYieldUnits.map(u => this.buildSubTradeYieldUnitRow(context, u));
      if (segmentRows.length > 0) await this.putSegmentRows(segmentRows);
      if (unitRows.length > 0) await this.putSubTradeYieldUnitRows(unitRows);

      const row: _AsOfTradeYieldSummary = {
        owner,
        tradeUuid: summary.tradeUuid,
        asOfDate: summary.asOfDate,
        asOfEpoch: summary.asOfEpoch,
        asOfDateTradeUuidSk: makeAsOfDateTradeUuidSk(summary.asOfDate, summary.tradeUuid),
        tradeUuidAsOfDateSk: makeTradeUuidAsOfDateSk(summary.tradeUuid, summary.asOfDate),
        peakSimultaneousCaR: summary.peakSimultaneousCaR,
        startEpoch: summary.startEpoch,
        endEpoch: summary.endEpoch,
        days: summary.days,
        totalGain: summary.totalGain,
        realizedGain: summary.realizedGain,
        unrealizedGain: summary.unrealizedGain,
        passiveGain: summary.passiveGain,
        feesAndCommissions: summary.feesAndCommissions,
        yield: summary.yield,
        annualizedYieldLinear: summary.annualizedYieldLinear,
        annualizedYieldCagr: summary.annualizedYieldCagr,
        priceCoverage: summary.priceCoverage,
        segmentUuids: summary.segments.map(s => s.uuid!) as TradeYieldSegmentUUID[],
        subTradeYieldUnitUuids: summary.subTradeYieldUnits.map(u => u.uuid!) as SubTradeYieldUnitUUID[],
        computedAt: summary.computedAt,
      };
      if (summary.error !== undefined) row.error = summary.error;
      if (summary.priceSource !== undefined) row.priceSource = summary.priceSource;
      if (summary.closingDate !== undefined) row.closingDate = summary.closingDate;
      if (summary.explanation !== undefined) row.explanation = summary.explanation;
      if (audit?.startedBy !== undefined) row.startedBy = audit.startedBy;
      if (audit?.jobId !== undefined) row.jobId = audit.jobId;

      await this.#dynamo.batchPut({[AS_OF_TRADE_YIELD_SUMMARIES]: [row]});
      log.info(`putAsOfTradeSummary: tradeUuid=${summary.tradeUuid} asOfDate=${summary.asOfDate} segments=${segmentRows.length} units=${unitRows.length}`);
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  async getAsOfTradeSummary(tradeUuid: TradeUUID, asOfDate: Datestamp): Promise<AsOfTradeYieldSegmentSummary | undefined> {
    const log = this.#log.setMethod('getAsOfTradeSummary');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    const context = asOfContext(asOfDate);
    try {
      const row = await this.#dynamo.get<_AsOfTradeYieldSummary>(
        AS_OF_TRADE_YIELD_SUMMARIES,
        {owner, asOfDateTradeUuidSk: makeAsOfDateTradeUuidSk(asOfDate, tradeUuid)},
      );
      if (!row) return undefined;
      const [segments, units] = await Promise.all([
        this.getSegmentRowsForTradeAndContext(tradeUuid, context).then(rs => rs.map(toTradeYieldSegment)),
        this.getSubTradeYieldUnitRowsForTradeAndContext(tradeUuid, context).then(rs => rs.map(toSubTradeYieldUnit)),
      ]);
      return toAsOfTradeYieldSummary(row, segments, units);
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /** Every as-of summary row for one trade across dates (no segment hydration). */
  async getAsOfTradeSummaryRowsForTrade(tradeUuid: TradeUUID, range?: DateRange): Promise<_AsOfTradeYieldSummary[]> {
    const log = this.#log.setMethod('getAsOfTradeSummaryRowsForTrade');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      const keyExpr = buildLsiQueryByPrefixWithRange(owner, 'tradeUuidAsOfDateSk', tradeUuid, range);
      return await this.#dynamo.query<_AsOfTradeYieldSummary>(AS_OF_TRADE_YIELD_SUMMARIES, BY_TRADE_INDEX, keyExpr);
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /** Every as-of summary row for one owner on one asOfDate (no segment hydration). */
  async getAsOfTradeSummaryRowsForOwnerAndDate(asOfDate: Datestamp): Promise<_AsOfTradeYieldSummary[]> {
    const log = this.#log.setMethod('getAsOfTradeSummaryRowsForOwnerAndDate');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      const keyExpr: KeyStructuredExpression = {
        partitionFieldName: 'owner',
        operator: '=',
        value: owner,
        sortFieldName: 'asOfDateTradeUuidSk',
        sortOperator: 'begins_with',
        sortValue: `${asOfDate}#`,
      };
      return await this.#dynamo.query<_AsOfTradeYieldSummary>(AS_OF_TRADE_YIELD_SUMMARIES, false, keyExpr);
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  // ── SINCE summary I/O ───────────────────────────────────────────────────────

  async putSinceTradeSummary(
    summary: SinceTradeYieldSegmentSummary,
    audit?: {startedBy?: string; jobId?: string},
  ): Promise<void> {
    const log = this.#log.setMethod('putSinceTradeSummary');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    const context = sinceContext(summary.sinceAnchorEpoch);
    try {
      await this.deleteFactRowsByTradeAndContext(summary.tradeUuid, context);

      const segmentRows = summary.segments.map(s => this.buildSegmentRow(context, s));
      const unitRows = summary.subTradeYieldUnits.map(u => this.buildSubTradeYieldUnitRow(context, u));
      if (segmentRows.length > 0) await this.putSegmentRows(segmentRows);
      if (unitRows.length > 0) await this.putSubTradeYieldUnitRows(unitRows);

      const row: _SinceTradeYieldSummary = {
        owner,
        tradeUuid: summary.tradeUuid,
        sinceAnchorEpoch: summary.sinceAnchorEpoch,
        sinceAnchorTradeUuidSk: makeSinceAnchorTradeUuidSk(summary.sinceAnchorEpoch, summary.tradeUuid),
        tradeUuidSinceAnchorSk: makeTradeUuidSinceAnchorSk(summary.tradeUuid, summary.sinceAnchorEpoch),
        peakSimultaneousCaR: summary.peakSimultaneousCaR,
        startEpoch: summary.startEpoch,
        endEpoch: summary.endEpoch,
        days: summary.days,
        totalGain: summary.totalGain,
        realizedGain: summary.realizedGain,
        unrealizedGain: summary.unrealizedGain,
        passiveGain: summary.passiveGain,
        feesAndCommissions: summary.feesAndCommissions,
        yield: summary.yield,
        annualizedYieldLinear: summary.annualizedYieldLinear,
        annualizedYieldCagr: summary.annualizedYieldCagr,
        gainSince: summary.gainSince,
        segmentUuids: summary.segments.map(s => s.uuid!) as TradeYieldSegmentUUID[],
        subTradeYieldUnitUuids: summary.subTradeYieldUnits.map(u => u.uuid!) as SubTradeYieldUnitUUID[],
        computedAt: summary.computedAt,
      };
      if (summary.priceSource !== undefined) row.priceSource = summary.priceSource;
      if (summary.closingDate !== undefined) row.closingDate = summary.closingDate;
      if (summary.explanation !== undefined) row.explanation = summary.explanation;
      if (audit?.startedBy !== undefined) row.startedBy = audit.startedBy;
      if (audit?.jobId !== undefined) row.jobId = audit.jobId;

      await this.#dynamo.batchPut({[SINCE_TRADE_YIELD_SUMMARIES]: [row]});
      log.info(`putSinceTradeSummary: tradeUuid=${summary.tradeUuid} anchor=${summary.sinceAnchorEpoch}`);
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  async getSinceTradeSummary(tradeUuid: TradeUUID, sinceAnchorEpoch: number): Promise<SinceTradeYieldSegmentSummary | undefined> {
    const log = this.#log.setMethod('getSinceTradeSummary');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    const context = sinceContext(sinceAnchorEpoch);
    try {
      const row = await this.#dynamo.get<_SinceTradeYieldSummary>(
        SINCE_TRADE_YIELD_SUMMARIES,
        {owner, sinceAnchorTradeUuidSk: makeSinceAnchorTradeUuidSk(sinceAnchorEpoch, tradeUuid)},
      );
      if (!row) return undefined;
      const [segments, units] = await Promise.all([
        this.getSegmentRowsForTradeAndContext(tradeUuid, context).then(rs => rs.map(toTradeYieldSegment)),
        this.getSubTradeYieldUnitRowsForTradeAndContext(tradeUuid, context).then(rs => rs.map(toSubTradeYieldUnit)),
      ]);
      return toSinceTradeYieldSummary(row, segments, units);
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /** Every since-summary row for one trade across anchors (no segment hydration). */
  async getSinceTradeSummaryRowsForTrade(tradeUuid: TradeUUID): Promise<_SinceTradeYieldSummary[]> {
    const log = this.#log.setMethod('getSinceTradeSummaryRowsForTrade');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      const keyExpr: KeyStructuredExpression = {
        partitionFieldName: 'owner',
        operator: '=',
        value: owner,
        sortFieldName: 'tradeUuidSinceAnchorSk',
        sortOperator: 'begins_with',
        sortValue: `${tradeUuid}#`,
      };
      return await this.#dynamo.query<_SinceTradeYieldSummary>(SINCE_TRADE_YIELD_SUMMARIES, BY_TRADE_INDEX, keyExpr);
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  // ── Cascade-delete ──────────────────────────────────────────────────────────

  /**
   * Hard delete of every persistence-layer artifact for one trade — all summary
   * rows (open + every as-of + every since) AND every segment + sub-trade-unit
   * fact row in every context. Used by `trade-deletion-orchestrator` and by the
   * trade-uuid rotation path.
   *
   * Returns total rows deleted across all five tables.
   */
  async deleteByTrade(tradeUuid: TradeUUID): Promise<number> {
    const log = this.#log.setMethod('deleteByTrade');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    const _t = Date.now();
    try {
      const [segmentRows, unitRows, openRow, asOfRows, sinceRows] = await Promise.all([
        this.#queryAllSegmentsForTrade(tradeUuid),
        this.#queryAllUnitsForTrade(tradeUuid),
        this.#dynamo.get<_OpenTradeYieldSummary>(OPEN_TRADE_YIELD_SUMMARIES, {owner, tradeUuid}),
        this.getAsOfTradeSummaryRowsForTrade(tradeUuid),
        this.getSinceTradeSummaryRowsForTrade(tradeUuid),
      ]);
      let total = 0;

      if (segmentRows.length > 0) {
        const keys = segmentRows.map(r => ({owner: r.owner, contextTradeStartSk: r.contextTradeStartSk}));
        const count = keys.length;
        await this.#dynamo.batchDelete({[TRADE_YIELD_SEGMENTS]: keys});
        total += count;
      }
      if (unitRows.length > 0) {
        const keys = unitRows.map(r => ({owner: r.owner, contextTradeSubTradeUnitSk: r.contextTradeSubTradeUnitSk}));
        const count = keys.length;
        await this.#dynamo.batchDelete({[SUB_TRADE_YIELD_UNITS]: keys});
        total += count;
      }
      if (openRow) {
        await this.#dynamo.batchDelete({[OPEN_TRADE_YIELD_SUMMARIES]: [{owner, tradeUuid}]});
        total += 1;
      }
      if (asOfRows.length > 0) {
        const keys = asOfRows.map(r => ({owner: r.owner, asOfDateTradeUuidSk: r.asOfDateTradeUuidSk}));
        const count = keys.length;
        await this.#dynamo.batchDelete({[AS_OF_TRADE_YIELD_SUMMARIES]: keys});
        total += count;
      }
      if (sinceRows.length > 0) {
        const keys = sinceRows.map(r => ({owner: r.owner, sinceAnchorTradeUuidSk: r.sinceAnchorTradeUuidSk}));
        const count = keys.length;
        await this.#dynamo.batchDelete({[SINCE_TRADE_YIELD_SUMMARIES]: keys});
        total += count;
      }
      log.timing(`[trace:trade-yield-persistence] deleteByTrade: ${Date.now() - _t}ms | tradeUuid=${tradeUuid} total=${total}`);
      return total;
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /**
   * Delete fact rows (segments + units) for one (trade, context). Used by the
   * summary write path to replace the prior context's facts atomically. Does
   * NOT touch summary rows.
   */
  async deleteFactRowsByTradeAndContext(tradeUuid: TradeUUID, context: YieldContext): Promise<number> {
    const log = this.#log.setMethod('deleteFactRowsByTradeAndContext');
    try {
      const [segments, units] = await Promise.all([
        this.getSegmentRowsForTradeAndContext(tradeUuid, context),
        this.getSubTradeYieldUnitRowsForTradeAndContext(tradeUuid, context),
      ]);
      let total = 0;
      if (segments.length > 0) {
        const keys = segments.map(r => ({owner: r.owner, contextTradeStartSk: r.contextTradeStartSk}));
        const count = keys.length;
        await this.#dynamo.batchDelete({[TRADE_YIELD_SEGMENTS]: keys});
        total += count;
      }
      if (units.length > 0) {
        const keys = units.map(r => ({owner: r.owner, contextTradeSubTradeUnitSk: r.contextTradeSubTradeUnitSk}));
        const count = keys.length;
        await this.#dynamo.batchDelete({[SUB_TRADE_YIELD_UNITS]: keys});
        total += count;
      }
      log.info(`deleteFactRowsByTradeAndContext: tradeUuid=${tradeUuid} context=${context} total=${total}`);
      return total;
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  /** Delete the open-context fact rows + summary row for one trade. */
  async deleteOpenTradeRowsByTrade(tradeUuid: TradeUUID): Promise<number> {
    const log = this.#log.setMethod('deleteOpenTradeRowsByTrade');
    const owner = getSessionOwner(this.ec) as AccountOwner;
    try {
      const factCount = await this.deleteFactRowsByTradeAndContext(tradeUuid, OPEN_CONTEXT);
      const openRow = await this.#dynamo.get<_OpenTradeYieldSummary>(OPEN_TRADE_YIELD_SUMMARIES, {owner, tradeUuid});
      let summaryCount = 0;
      if (openRow) {
        await this.#dynamo.batchDelete({[OPEN_TRADE_YIELD_SUMMARIES]: [{owner, tradeUuid}]});
        summaryCount = 1;
      }
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
      const keys = rows.map(r => ({owner: r.owner, asOfDateTradeUuidSk: r.asOfDateTradeUuidSk}));
      const summaryCount = keys.length;
      await this.#dynamo.batchDelete({[AS_OF_TRADE_YIELD_SUMMARIES]: keys});
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
      const keys = affected.map(r => ({owner: r.owner, sinceAnchorTradeUuidSk: r.sinceAnchorTradeUuidSk}));
      const summaryCount = keys.length;
      await this.#dynamo.batchDelete({[SINCE_TRADE_YIELD_SUMMARIES]: keys});
      log.info(`deleteSinceSummariesByTradeAndAnchorRange: tradeUuid=${tradeUuid} fromEpoch=${fromEpoch} summaries=${summaryCount} facts=${factCount}`);
      return summaryCount + factCount;
    } catch (err) {
      throw logAndEnhanceError(log, err as Error);
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  async #queryAllSegmentsForTrade(tradeUuid: TradeUUID): Promise<_TradeYieldSegment[]> {
    const owner = getSessionOwner(this.ec) as AccountOwner;
    const keyExpr: KeyStructuredExpression = {
      partitionFieldName: 'owner',
      operator: '=',
      value: owner,
      sortFieldName: 'tradeContextStartSk',
      sortOperator: 'begins_with',
      sortValue: `${tradeUuid}#`,
    };
    return await this.#dynamo.query<_TradeYieldSegment>(TRADE_YIELD_SEGMENTS, BY_TRADE_INDEX, keyExpr);
  }

  async #queryAllUnitsForTrade(tradeUuid: TradeUUID): Promise<_SubTradeYieldUnit[]> {
    const owner = getSessionOwner(this.ec) as AccountOwner;
    const keyExpr: KeyStructuredExpression = {
      partitionFieldName: 'owner',
      operator: '=',
      value: owner,
      sortFieldName: 'tradeContextSubTradeUnitSk',
      sortOperator: 'begins_with',
      sortValue: `${tradeUuid}#`,
    };
    return await this.#dynamo.query<_SubTradeYieldUnit>(SUB_TRADE_YIELD_UNITS, BY_TRADE_INDEX, keyExpr);
  }
}

/**
 * Build an LSI Query keyed by `owner` with an optional date-range bound, where the LSI
 * SK is structured as `${prefix}#${asOfDate}`. Prefix is typically a TradeUUID.
 */
function buildLsiQueryByPrefixWithRange(
  owner: AccountOwner,
  sortFieldName: string,
  prefix: string,
  range?: DateRange,
): KeyStructuredExpression {
  const partitionPart: KeyStructuredExpression = {
    partitionFieldName: 'owner',
    operator: '=',
    value: owner,
  };
  if (range?.from && range?.to) {
    return {
      ...partitionPart,
      sortFieldName,
      sortOperator: 'between',
      sortValue: [`${prefix}#${range.from}`, `${prefix}#${range.to}#~`],
    };
  }
  if (range?.from) {
    return {
      ...partitionPart,
      sortFieldName,
      sortOperator: 'between',
      sortValue: [`${prefix}#${range.from}`, `${prefix}#~`],
    };
  }
  if (range?.to) {
    return {
      ...partitionPart,
      sortFieldName,
      sortOperator: 'between',
      sortValue: [`${prefix}#`, `${prefix}#${range.to}#~`],
    };
  }
  return {
    ...partitionPart,
    sortFieldName,
    sortOperator: 'begins_with',
    sortValue: `${prefix}#`,
  };
}

// Re-exports for consumer convenience.
export {
  OPEN_CONTEXT,
  asOfContext,
  sinceContext,
  padEpoch,
};
