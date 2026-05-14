/*
Created by Franz Zemen 05/14/2026
License Type: UNLICENSED
*/

import {DBRecord} from '@franzzemen/endpoint-application';
import {AccountOwner} from '@franzzemen/endpoint-financial-identity';
import {Archetype, TradeUUID} from '@franzzemen/financial-identity';
import {Datestamp} from '@franzzemen/utility';
import {padEpoch} from './yield-context.js';

/**
 * One day's archetype contribution to a trade's mark-to-market exposure.
 * Used by the FE temporal-segment chart to render stacked CaR by archetype.
 */
export type SegmentArchetypeContribution = {
  archetype: Archetype;
  carContribution: number;
};

/**
 * Persisted daily MTM fact for one (owner, tradeUuid, dateEpoch). Populated lazily
 * by `lambda-trade-daily-mtm-populator` (yield-segment-redesign PRD E11.5) on first
 * chart view of a trade, and tail-extended nightly for active trades.
 *
 * SK strategy:
 * - Base RANGE = `tradeDateSk = '${tradeUuid}#${padEpoch(dateEpoch)}'`.
 *   "All daily MTM rows for one trade" = prefix scan `'${tradeUuid}#'`.
 *
 * No LSI is required — every read path is per-trade (chart panel) or per-owner
 * scan (the emergent "watchlist" used by the nightly tail-extender is just a
 * distinct-tradeUuid pass over the base table).
 *
 * Cascade contract:
 * - Trade uuid rotation / trade deletion → cascade-delete by base-SK prefix
 *   `'${tradeUuid}#'`.
 * - Yield-math invalidation → wipe affected `tradeUuid` prefix; populator
 *   repopulates on next view.
 */
export type _TradeDailyMTMSeries = DBRecord & {
  owner: AccountOwner;
  tradeUuid: TradeUUID;
  tradeDateSk: string;

  /** Midnight-UTC epoch of the trading date this row represents. */
  dateEpoch: number;
  /** ISO date for the trading day (denormalized for FE convenience). */
  date: Datestamp;

  /** Total MTM value of the trade at end-of-day (signedQty × close × multiplier, summed). */
  mtmAmount: number;
  /** Capital-at-risk at this date — denominator for the day's yield contribution. */
  carAtDate: number;
  /** Archetype-level CaR contributions for stacked chart rendering. */
  segmentArchetypeContributions: SegmentArchetypeContribution[];
  /**
   * Fraction of open exposure that had a real close price on this date.
   * `1.0` = fully priced; `<1.0` = some open positions had no historical close.
   * Set by `decomposeTradeGains.priceCoverage`.
   */
  priceCoverage: number;

  computedAt: number;
};

export function makeTradeDateSk(tradeUuid: TradeUUID, dateEpoch: number): string {
  return `${tradeUuid}#${padEpoch(dateEpoch)}`;
}
