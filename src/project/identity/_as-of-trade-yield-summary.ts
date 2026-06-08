/*
Created by Franz Zemen 05/11/2026
License Type: UNLICENSED
*/

import {Provenance} from '@franzzemen/admin-identity';
import {DBRecord} from '@franzzemen/endpoint-application';
import {AccountOwner} from '@franzzemen/endpoint-financial-identity';
import {
  AsOfTradeYieldSegmentSummary,
  SubTradeYieldUnit,
  TradeUUID,
  TradeYieldSegment,
} from '@franzzemen/financial-identity';
import {Datestamp} from '@franzzemen/utility';
import type {Selectable} from 'kysely';
import type {AsOfTradeYieldSummariesTable} from '@franzzemen/brokenstock-postgres-ddl/schema-types';

/**
 * In-memory as-of trade yield summary. One row per (owner, trade_id, as_of_date).
 *
 * In Postgres (Era 4 / 4a) the PK is (owner, trade_id, as_of_date); the DDB SK
 * encodings and the `segmentUuids[]`/`subTradeYieldUnitUuids[]` reference arrays
 * are DROPPED (4a-4b). Summary scalars are stored; segments/units hydrate from the
 * fact tables (`WHERE (owner, trade_id, context='asOf:<date>')`).
 */
export type _AsOfTradeYieldSummary = DBRecord & {
  owner: AccountOwner;
  tradeUuid: TradeUUID;
  asOfDate: Datestamp;
  asOfEpoch: number;

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

  // Sub-trade W/L tally — memory `project_win_loss_tier_design`.
  subTradeWins: number;
  subTradeLosses: number;
  subTradeBreakevens: number;
  subTradeWinRate: number | null;
  subTradeWinAmount: number;
  subTradeLossAmount: number;

  priceCoverage: number;
  error?: string;
  priceSource?: 'realtime' | 'most-recent-close';
  closingDate?: Datestamp;
  computedAt: number;
  explanation?: string;
} & Partial<Provenance>;
// startedBy + jobId — formerly flat on this row — are now part of Partial<Provenance>
// along with writerLambda, writerVersion, writtenAt. Optional on the row for read-tolerance
// with pre-PRD rows; required on the put-method parameter. See persistence-row-provenance.prd.md.

export function toAsOfTradeYieldSummary(
  row: _AsOfTradeYieldSummary,
  segments: TradeYieldSegment[],
  subTradeYieldUnits: SubTradeYieldUnit[],
): AsOfTradeYieldSegmentSummary {
  const summary: AsOfTradeYieldSegmentSummary = {
    tradeUuid: row.tradeUuid,
    asOfDate: row.asOfDate,
    asOfEpoch: row.asOfEpoch,
    priceCoverage: row.priceCoverage,
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
  if (row.error !== undefined) summary.error = row.error;
  if (row.priceSource !== undefined) summary.priceSource = row.priceSource;
  if (row.closingDate !== undefined) summary.closingDate = row.closingDate;
  if (row.explanation !== undefined) summary.explanation = row.explanation;
  return summary;
}

/**
 * Row shape from a SELECT against `as_of_trade_yield_summaries` where the DATE
 * columns (`as_of_date`, `closing_date`) are projected with `::text` so they
 * materialize as 'YYYY-MM-DD' strings (the transfers DATE off-by-one convention).
 */
export type AsOfSummaryRow = Omit<Selectable<AsOfTradeYieldSummariesTable>, 'as_of_date' | 'closing_date'> & {
  as_of_date: string;
  closing_date: string | null;
};

/**
 * Map a PG `as_of_trade_yield_summaries` row into `_AsOfTradeYieldSummary`
 * (NUMERIC/BIGINT → Number() at the boundary). The PG nullable analytics columns
 * (error rows carry nulls) are coerced to 0 to satisfy the non-null in-memory /
 * wire contract — see the repoint report's flagged judgment call.
 */
export function asOfSummaryRowToRecord(row: AsOfSummaryRow): _AsOfTradeYieldSummary {
  const record: _AsOfTradeYieldSummary = {
    owner: row.owner as AccountOwner,
    tradeUuid: row.trade_id as TradeUUID,
    asOfDate: row.as_of_date as Datestamp,
    asOfEpoch: Number(row.as_of_epoch),
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
    subTradeWins: row.sub_trade_wins ?? 0,
    subTradeLosses: row.sub_trade_losses ?? 0,
    subTradeBreakevens: row.sub_trade_breakevens ?? 0,
    subTradeWinRate: row.sub_trade_win_rate === null ? null : Number(row.sub_trade_win_rate),
    subTradeWinAmount: Number(row.sub_trade_win_amount ?? 0),
    subTradeLossAmount: Number(row.sub_trade_loss_amount ?? 0),
    priceCoverage: Number(row.price_coverage ?? 0),
    computedAt: Number(row.computed_at),
  };
  if (row.error !== null) record.error = row.error;
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
