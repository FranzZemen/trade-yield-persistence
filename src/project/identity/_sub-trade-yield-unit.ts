/*
Created by Franz Zemen 05/11/2026
License Type: UNLICENSED
*/

import {Provenance} from '@franzzemen/admin-identity';
import {DBRecord} from '@franzzemen/endpoint-application';
import {AccountOwner} from '@franzzemen/endpoint-financial-identity';
import {SubTradeUUID, SubTradeYieldUnit, SubTradeYieldUnitUUID, TradeUUID} from '@franzzemen/financial-identity';
import type {Selectable} from 'kysely';
import type {SubTradeYieldUnitsTable} from '@franzzemen/brokenstock-postgres-ddl/schema-types';
import {YieldContext} from './yield-context.js';

/**
 * In-memory forensic per-sub-trade "as-if-no-spread" yield-unit row. One row per
 * `SubTradeYieldUnit` scoped by `context` (mirrors `_TradeYieldSegment`).
 *
 * In Postgres this is the `sub_trade_yield_units` row (typed scalar columns). The old
 * DDB SK encodings are gone — reads are `WHERE (owner, trade_id, context)`.
 */
export type _SubTradeYieldUnit = DBRecord & {
  owner: AccountOwner;
  context: YieldContext;
  tradeUuid: TradeUUID;
  subTradeUuid: SubTradeUUID;
  unit: SubTradeYieldUnit;
} & Partial<Provenance>;
// Provenance fields optional on row for read-tolerance; required on put-method parameter.
// See persistence-row-provenance.prd.md.

export function toSubTradeYieldUnit(row: _SubTradeYieldUnit): SubTradeYieldUnit {
  return row.unit;
}

type UnitRow = Selectable<SubTradeYieldUnitsTable>;

/**
 * Map a PG `sub_trade_yield_units` row back into a `_SubTradeYieldUnit`
 * (NUMERIC/BIGINT columns → Number() at the boundary).
 */
export function unitRowToRecord(row: UnitRow): _SubTradeYieldUnit {
  const unit: SubTradeYieldUnit = {
    uuid: row.unit_id as SubTradeYieldUnitUUID,
    tradeUuid: row.trade_id as TradeUUID,
    subTradeUuid: row.sub_trade_id as SubTradeUUID,
    symbol: row.symbol,
    archetype: row.archetype as SubTradeYieldUnit['archetype'],
    denominator: Number(row.denominator),
    startEpoch: Number(row.start_epoch),
    endEpoch: row.end_epoch === null ? null : Number(row.end_epoch),
    gain: Number(row.gain),
    days: row.days,
    yield: Number(row.yield),
    feesAndCommissions: Number(row.fees_and_commissions),
  };
  if (row.mtm_price_at_boundary !== null) unit.markToMarketPriceAtBoundary = Number(row.mtm_price_at_boundary);
  if (row.explanation !== null) unit.explanation = row.explanation;

  const record: _SubTradeYieldUnit = {
    owner: row.owner as AccountOwner,
    context: row.context as YieldContext,
    tradeUuid: row.trade_id as TradeUUID,
    subTradeUuid: row.sub_trade_id as SubTradeUUID,
    unit,
  };
  if (row.started_by !== null) record.startedBy = row.started_by;
  if (row.job_id !== null) record.jobId = row.job_id;
  if (row.writer !== null) record.writerLambda = row.writer;
  if (row.writer_version !== null) record.writerVersion = row.writer_version;
  if (row.written_at !== null) record.writtenAt = Number(row.written_at);
  return record;
}
