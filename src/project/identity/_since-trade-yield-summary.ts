/*
Created by Franz Zemen 05/11/2026
License Type: UNLICENSED
*/

import {DBRecord} from '@franzzemen/endpoint-application';
import {AccountOwner} from '@franzzemen/endpoint-financial-identity';
import {
  SinceTradeYieldSegmentSummary,
  SubTradeYieldUnit,
  SubTradeYieldUnitUUID,
  TradeUUID,
  TradeYieldSegment,
  TradeYieldSegmentUUID,
} from '@franzzemen/financial-identity';
import {Datestamp} from '@franzzemen/utility';
import {padEpoch} from './yield-context.js';

/**
 * Persisted since-anchor trade yield summary. One row per (owner, sinceAnchorEpoch, tradeUuid).
 *
 * SK strategy:
 * - `sinceAnchorTradeUuidSk = '${padEpoch(sinceAnchorEpoch)}#${tradeUuid}'` — base RANGE,
 *   anchor-first. Prefix-scan returns every since-summary for one owner at one anchor.
 * - `tradeUuidSinceAnchorSk = '${tradeUuid}#${padEpoch(sinceAnchorEpoch)}'` — BY_TRADE_INDEX
 *   LSI; prefix-scan returns every anchor for one trade (cascade-delete-by-trade target).
 *
 * Anchor epochs are zero-padded to 13 digits so lexicographic key order = numeric epoch order.
 */
export type _SinceTradeYieldSummary = DBRecord & {
  owner: AccountOwner;
  tradeUuid: TradeUUID;
  sinceAnchorEpoch: number;
  sinceAnchorTradeUuidSk: string;
  tradeUuidSinceAnchorSk: string;

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

  segmentUuids: TradeYieldSegmentUUID[];
  subTradeYieldUnitUuids: SubTradeYieldUnitUUID[];

  priceSource?: 'realtime' | 'most-recent-close';
  closingDate?: Datestamp;
  computedAt: number;
  explanation?: string;

  startedBy?: string;
  jobId?: string;
};

export function makeSinceAnchorTradeUuidSk(sinceAnchorEpoch: number, tradeUuid: TradeUUID): string {
  return `${padEpoch(sinceAnchorEpoch)}#${tradeUuid}`;
}

export function makeTradeUuidSinceAnchorSk(tradeUuid: TradeUUID, sinceAnchorEpoch: number): string {
  return `${tradeUuid}#${padEpoch(sinceAnchorEpoch)}`;
}

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
