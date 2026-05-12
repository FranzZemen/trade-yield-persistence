/*
Created by Franz Zemen 05/11/2026
License Type: UNLICENSED
*/

import {DBRecord} from '@franzzemen/endpoint-application';
import {AccountOwner} from '@franzzemen/endpoint-financial-identity';
import {
  AsOfTradeYieldSegmentSummary,
  SubTradeYieldUnit,
  SubTradeYieldUnitUUID,
  TradeUUID,
  TradeYieldSegment,
  TradeYieldSegmentUUID,
} from '@franzzemen/financial-identity';
import {Datestamp} from '@franzzemen/utility';

/**
 * Persisted as-of trade yield summary. One row per (owner, asOfDate, tradeUuid).
 *
 * SK strategy mirrors the legacy `_AsOfTradeYield` row:
 * - `asOfDateTradeUuidSk = '${asOfDate}#${tradeUuid}'` — base RANGE; prefix-scan returns
 *   every as-of trade summary for one owner on one date.
 * - `tradeUuidAsOfDateSk = '${tradeUuid}#${asOfDate}'` — BY_TRADE_INDEX LSI; prefix-scan
 *   returns every as-of-date for one trade (cascade-delete-by-trade target).
 *
 * Like `_OpenTradeYieldSummary` the row stores summary scalars + segment/unit uuid
 * references; full hydration via fact-table query.
 */
export type _AsOfTradeYieldSummary = DBRecord & {
  owner: AccountOwner;
  tradeUuid: TradeUUID;
  asOfDate: Datestamp;
  asOfEpoch: number;
  asOfDateTradeUuidSk: string;
  tradeUuidAsOfDateSk: string;

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

  segmentUuids: TradeYieldSegmentUUID[];
  subTradeYieldUnitUuids: SubTradeYieldUnitUUID[];

  priceCoverage: number;
  error?: string;
  priceSource?: 'realtime' | 'most-recent-close';
  closingDate?: Datestamp;
  computedAt: number;
  explanation?: string;

  startedBy?: string;
  jobId?: string;
};

export function makeAsOfDateTradeUuidSk(asOfDate: Datestamp, tradeUuid: TradeUUID): string {
  return `${asOfDate}#${tradeUuid}`;
}

export function makeTradeUuidAsOfDateSk(tradeUuid: TradeUUID, asOfDate: Datestamp): string {
  return `${tradeUuid}#${asOfDate}`;
}

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
    computedAt: row.computedAt,
  };
  if (row.error !== undefined) summary.error = row.error;
  if (row.priceSource !== undefined) summary.priceSource = row.priceSource;
  if (row.closingDate !== undefined) summary.closingDate = row.closingDate;
  if (row.explanation !== undefined) summary.explanation = row.explanation;
  return summary;
}
