/*
Created by Franz Zemen 05/11/2026
License Type: UNLICENSED
*/

import {DBRecord} from '@franzzemen/endpoint-application';
import {AccountOwner} from '@franzzemen/endpoint-financial-identity';
import {
  SubTradeYieldUnitUUID,
  TradeUUID,
  TradeYieldSegment,
  TradeYieldSegmentSummary,
  TradeYieldSegmentUUID,
  SubTradeYieldUnit,
} from '@franzzemen/financial-identity';
import {Datestamp} from '@franzzemen/utility';

/**
 * Persisted shape of the rolling open-trade yield summary. One row per (owner, tradeUuid).
 *
 * Stored fields are the scalars of the public `TradeYieldSegmentSummary` PLUS
 * `segmentUuids[]` / `subTradeYieldUnitUuids[]` reference arrays back into the
 * fact tables. The public `segments[]` and `subTradeYieldUnits[]` arrays are
 * NOT persisted on the summary row — they're hydrated by the trusted API on
 * read by Query-ing the fact tables. This keeps summary rows compact and
 * avoids segment/summary drift on partial writes.
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

  segmentUuids: TradeYieldSegmentUUID[];
  subTradeYieldUnitUuids: SubTradeYieldUnitUUID[];

  priceSource?: 'realtime' | 'most-recent-close';
  closingDate?: Datestamp;
  computedAt: number;
  explanation?: string;
};

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
  return summary;
}
