/*
Created by Franz Zemen 05/11/2026
License Type: UNLICENSED
*/

import {Provenance} from '@franzzemen/admin-identity';
import {DBRecord} from '@franzzemen/endpoint-application';
import {AccountOwner} from '@franzzemen/endpoint-financial-identity';
import {
  TradeUUID,
  TradeLineageGraph,
  TradeYieldSegment,
  TradeYieldSegmentSummary,
  SubTradeYieldUnit,
} from '@franzzemen/financial-identity';
import {Datestamp} from '@franzzemen/utility';
import type {Selectable} from 'kysely';
import type {OpenTradeYieldSummariesTable} from '@franzzemen/brokenstock-postgres-ddl/schema-types';

/**
 * In-memory shape of the rolling open-trade yield summary. One row per (owner, tradeUuid).
 *
 * Stored fields are the scalars of the public `TradeYieldSegmentSummary`. The
 * `segments[]` / `subTradeYieldUnits[]` arrays are NOT on the summary row —
 * they're hydrated by the trusted API on read from the segments + units tables
 * (`WHERE (owner, trade_id, context='open')`). In Postgres (Era 4 / 4a) the DDB
 * `segmentUuids[]` / `subTradeYieldUnitUuids[]` reference arrays are DROPPED
 * (era-4-4a-yield-persistence-ddl.prd.md 4a-4b).
 */
export type _OpenTradeYieldSummary = DBRecord & {
  owner: AccountOwner;
  tradeUuid: TradeUUID;

  peakSimultaneousCaR: number;
  startEpoch: number;
  endEpoch: number | null;
  days: number;
  totalGain: number;
  realizedGain: number;
  unrealizedGain: number;
  passiveGain: number;
  feesAndCommissions: number;
  yield: number;
  annualizedYieldLinear: number;
  annualizedYieldCagr: number;

  // Sub-trade W/L tally (memory `project_win_loss_tier_design`). Atom = closed
  // sub-trade. Stored on the row so reads can hydrate the public summary
  // without re-running tallySubTradeOutcomes.
  subTradeWins: number;
  subTradeLosses: number;
  subTradeBreakevens: number;
  subTradeWinRate: number | null;
  subTradeWinAmount: number;
  subTradeLossAmount: number;

  priceSource?: 'realtime' | 'most-recent-close';
  closingDate?: Datestamp;
  computedAt: number;
  explanation?: string;
  // E11.5 cache-quality: see TradeYieldSegmentSummary docstring.
  priceCoverage?: number;
  recomputeAttempts?: number;

  // Managed-roll v3 lineage inference output (render-only). Persisted as the
  // `lineage_graph` jsonb column; hydrated only on single-trade reads (includeLineage).
  // Undefined for equity-only trades. See restore-managed-roll-lineage-persistence.prd.md.
  lineageGraph?: TradeLineageGraph;
} & Partial<Provenance>;
// Provenance fields (startedBy, jobId, writerLambda, writerVersion, writtenAt) are
// optional on the row for read-tolerance with pre-PRD rows; required on the put-method
// parameter. See persistence-row-provenance.prd.md.

/**
 * Project a persisted `_OpenTradeYieldSummary` to the public
 * `TradeYieldSegmentSummary` wire shape, hydrating segments + sub-trade yield
 * units from arrays supplied by the caller (typically just-queried from the
 * segments + units fact tables for matching context+tradeUuid).
 */
export function toOpenTradeYieldSummary(
  row: _OpenTradeYieldSummary,
  segments: TradeYieldSegment[],
  subTradeYieldUnits: SubTradeYieldUnit[],
): TradeYieldSegmentSummary {
  const summary: TradeYieldSegmentSummary = {
    tradeUuid: row.tradeUuid,
    peakSimultaneousCaR: row.peakSimultaneousCaR,
    startEpoch: row.startEpoch,
    endEpoch: row.endEpoch,
    days: row.days,
    totalGain: row.totalGain,
    realizedGain: row.realizedGain,
    unrealizedGain: row.unrealizedGain,
    passiveGain: row.passiveGain,
    feesAndCommissions: row.feesAndCommissions,
    yield: row.yield,
    annualizedYieldLinear: row.annualizedYieldLinear,
    annualizedYieldCagr: row.annualizedYieldCagr,
    segments,
    subTradeYieldUnits,
    subTradeWins:       row.subTradeWins,
    subTradeLosses:     row.subTradeLosses,
    subTradeBreakevens: row.subTradeBreakevens,
    subTradeWinRate:    row.subTradeWinRate,
    subTradeWinAmount:  row.subTradeWinAmount,
    subTradeLossAmount: row.subTradeLossAmount,
    computedAt: row.computedAt,
  };
  if (row.priceSource !== undefined) summary.priceSource = row.priceSource;
  if (row.closingDate !== undefined) summary.closingDate = row.closingDate;
  if (row.explanation !== undefined) summary.explanation = row.explanation;
  if (row.priceCoverage !== undefined) summary.priceCoverage = row.priceCoverage;
  if (row.recomputeAttempts !== undefined) summary.recomputeAttempts = row.recomputeAttempts;
  if (row.lineageGraph !== undefined) summary.lineageGraph = row.lineageGraph;
  return summary;
}
