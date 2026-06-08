/*
Created by Franz Zemen 05/14/2026
License Type: UNLICENSED
*/

import {Provenance} from '@franzzemen/admin-identity';
import {DBRecord} from '@franzzemen/endpoint-application';
import {AccountOwner} from '@franzzemen/endpoint-financial-identity';
import {Archetype, TradeUUID} from '@franzzemen/financial-identity';
import {Datestamp} from '@franzzemen/utility';
import type {Selectable} from 'kysely';
import type {
  TradeDailyMtmSeriesTable,
  TradeDailyMtmArchetypeContributionsTable,
} from '@franzzemen/brokenstock-postgres-ddl/schema-types';

/**
 * One day's archetype contribution to a trade's mark-to-market exposure.
 * Used by the FE temporal-segment chart to render stacked CaR by archetype.
 */
export type SegmentArchetypeContribution = {
  archetype: Archetype;
  carContribution: number;
};

/**
 * In-memory daily MTM fact for one (owner, trade_id, date_epoch). Populated lazily
 * by the daily-mtm populator (yield-segment-redesign PRD E11.5).
 *
 * In Postgres (Era 4 / 4a) this is the `trade_daily_mtm_series` row plus its child
 * `trade_daily_mtm_archetype_contributions` rows (the bounded
 * `segmentArchetypeContributions[]`). The DDB `tradeDateSk` encoding is gone — reads
 * are by (owner, trade_id) ordered by date.
 */
export type _TradeDailyMTMSeries = DBRecord & {
  owner: AccountOwner;
  tradeUuid: TradeUUID;

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
} & Partial<Provenance>;
// Provenance fields optional on row for read-tolerance; required on put-method parameter.
// See persistence-row-provenance.prd.md.
// NOTE: the trade_daily_mtm_series table has NO provenance columns; provenance is
// accepted on the put method (parity with the other put methods) but not persisted.

/**
 * Row shape from a SELECT against `trade_daily_mtm_series` where `date` is projected
 * with `::text` so it materializes as a 'YYYY-MM-DD' string (DATE off-by-one convention).
 */
export type DailyMtmRow = Omit<Selectable<TradeDailyMtmSeriesTable>, 'date'> & {date: string};
type ContributionRow = Selectable<TradeDailyMtmArchetypeContributionsTable>;

/**
 * Map a PG `trade_daily_mtm_series` row + its child archetype-contribution rows back
 * into a `_TradeDailyMTMSeries` (NUMERIC/BIGINT → Number() at the boundary).
 */
export function dailyMtmRowToRecord(row: DailyMtmRow, contributions: ContributionRow[]): _TradeDailyMTMSeries {
  return {
    owner: row.owner as AccountOwner,
    tradeUuid: row.trade_id as TradeUUID,
    dateEpoch: Number(row.date_epoch),
    date: row.date as Datestamp,
    mtmAmount: Number(row.mtm_amount),
    carAtDate: Number(row.car_at_date),
    segmentArchetypeContributions: contributions.map(c => ({
      archetype: c.archetype as Archetype,
      carContribution: Number(c.car_contribution),
    })),
    priceCoverage: Number(row.price_coverage),
    computedAt: Number(row.computed_at),
  };
}
