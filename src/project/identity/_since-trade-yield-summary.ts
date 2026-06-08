/*
Created by Franz Zemen 05/11/2026
License Type: UNLICENSED
*/

import {Provenance} from '@franzzemen/admin-identity';
import {DBRecord} from '@franzzemen/endpoint-application';
import {AccountOwner} from '@franzzemen/endpoint-financial-identity';
import {
  SinceTradeYieldSegmentSummary,
  SubTradeYieldUnit,
  TradeUUID,
  TradeYieldSegment,
} from '@franzzemen/financial-identity';
import {Datestamp} from '@franzzemen/utility';
import type {Selectable} from 'kysely';
import type {SinceTradeYieldSummariesTable} from '@franzzemen/brokenstock-postgres-ddl/schema-types';

/**
 * In-memory since-anchor trade yield summary. One row per (owner, trade_id, since_anchor_epoch).
 *
 * In Postgres (Era 4 / 4a) the PK is (owner, trade_id, since_anchor_epoch); the DDB
 * SK encodings and the segment/unit uuid reference arrays are DROPPED (4a-4b).
 */
export type _SinceTradeYieldSummary = DBRecord & {
  owner: AccountOwner;
  tradeUuid: TradeUUID;
  sinceAnchorEpoch: number;

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
  gainSince: number;

  // Sub-trade W/L tally — memory `project_win_loss_tier_design`.
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
} & Partial<Provenance>;
// Provenance fields (startedBy, jobId, writerLambda, writerVersion, writtenAt) optional on
// row for read-tolerance; required on put-method parameter. See persistence-row-provenance.prd.md.

export function toSinceTradeYieldSummary(
  row: _SinceTradeYieldSummary,
  segments: TradeYieldSegment[],
  subTradeYieldUnits: SubTradeYieldUnit[],
): SinceTradeYieldSegmentSummary {
  const summary: SinceTradeYieldSegmentSummary = {
    tradeUuid: row.tradeUuid,
    sinceAnchorEpoch: row.sinceAnchorEpoch,
    gainSince: row.gainSince,
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
  return summary;
}

/**
 * Row shape from a SELECT against `since_trade_yield_summaries` where `closing_date`
 * is projected with `::text` so it materializes as a 'YYYY-MM-DD' string.
 */
export type SinceSummaryRow = Omit<Selectable<SinceTradeYieldSummariesTable>, 'closing_date'> & {closing_date: string | null};

/**
 * Map a PG `since_trade_yield_summaries` row into `_SinceTradeYieldSummary`
 * (NUMERIC/BIGINT → Number() at the boundary). PG nullable analytics columns are
 * coerced to 0 to satisfy the non-null in-memory / wire contract (since rows are always
 * written fully-populated by this package). The W/L tally + price_source / closing_date /
 * explanation columns (added in 0.13.1) are now round-tripped.
 */
export function sinceSummaryRowToRecord(row: SinceSummaryRow): _SinceTradeYieldSummary {
  const record: _SinceTradeYieldSummary = {
    owner: row.owner as AccountOwner,
    tradeUuid: row.trade_id as TradeUUID,
    sinceAnchorEpoch: Number(row.since_anchor_epoch),
    peakSimultaneousCaR: Number(row.peak_simultaneous_car ?? 0),
    startEpoch: Number(row.start_epoch ?? 0),
    endEpoch: row.end_epoch === null ? null : Number(row.end_epoch),
    days: row.days ?? 0,
    totalGain: Number(row.total_gain ?? 0),
    realizedGain: Number(row.realized_gain ?? 0),
    unrealizedGain: Number(row.unrealized_gain ?? 0),
    passiveGain: Number(row.passive_gain ?? 0),
    feesAndCommissions: Number(row.fees_and_commissions ?? 0),
    yield: Number(row.yield ?? 0),
    annualizedYieldLinear: Number(row.annualized_yield_linear ?? 0),
    annualizedYieldCagr: Number(row.annualized_yield_cagr ?? 0),
    gainSince: Number(row.gain_since ?? 0),
    subTradeWins: row.sub_trade_wins ?? 0,
    subTradeLosses: row.sub_trade_losses ?? 0,
    subTradeBreakevens: row.sub_trade_breakevens ?? 0,
    subTradeWinRate: row.sub_trade_win_rate === null ? null : Number(row.sub_trade_win_rate),
    subTradeWinAmount: Number(row.sub_trade_win_amount ?? 0),
    subTradeLossAmount: Number(row.sub_trade_loss_amount ?? 0),
    computedAt: Number(row.computed_at),
  };
  if (row.price_source !== null) record.priceSource = row.price_source as 'realtime' | 'most-recent-close';
  if (row.closing_date !== null) record.closingDate = row.closing_date as Datestamp;
  if (row.explanation !== null) record.explanation = row.explanation;
  if (row.started_by !== null) record.startedBy = row.started_by;
  if (row.job_id !== null) record.jobId = row.job_id;
  if (row.writer !== null) record.writerLambda = row.writer;
  if (row.writer_version !== null) record.writerVersion = row.writer_version;
  if (row.written_at !== null) record.writtenAt = Number(row.written_at);
  return record;
}
