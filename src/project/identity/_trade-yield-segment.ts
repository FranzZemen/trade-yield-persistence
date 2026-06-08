/*
Created by Franz Zemen 05/11/2026
License Type: UNLICENSED
*/

import {Provenance} from '@franzzemen/admin-identity';
import {DBRecord} from '@franzzemen/endpoint-application';
import {AccountOwner} from '@franzzemen/endpoint-financial-identity';
import {
  LeafChainUUID,
  SubTradeUUID,
  TradeYieldSegment,
  TradeYieldSegmentUUID,
  TradeUUID,
  TransactionUUID,
} from '@franzzemen/financial-identity';
import type {Selectable} from 'kysely';
import type {
  TradeYieldSegmentsTable,
  TradeYieldSegmentTransactionPortionsTable,
} from '@franzzemen/brokenstock-postgres-ddl/schema-types';
import {YieldContext} from './yield-context.js';

/**
 * In-memory per-segment fact row. Carries one `TradeYieldSegment` scoped by `context`
 * so the same trade can hold multiple segment sets (open + per-as-of-date + per-since-
 * anchor) without collision.
 *
 * In Postgres (Era 4 / 4a) this is the `trade_yield_segments` row (typed scalar columns)
 * plus its child `trade_yield_segment_transaction_portions` rows (the unbounded
 * `transactionPortions[]`). The old DDB SK encodings (`contextTradeStartSk` /
 * `tradeContextStartSk`) are gone — reads are `WHERE (owner, trade_id, context)`.
 *
 * Every wire `TradeYieldSegment` field has a column and round-trips, including the
 * managed-rolls lineage/DAG fields: `explanation`, `leafChainUuids`,
 * `priorSegmentUuids`, `closingTransactionUuids`, `openingTransactionUuids`,
 * `familyClusterId`, and `boundaryQuantityDelta` (split across
 * `boundary_qty_delta_prior` / `boundary_qty_delta_current`).
 */
export type _TradeYieldSegment = DBRecord & {
  owner: AccountOwner;
  context: YieldContext;
  tradeUuid: TradeUUID;
  segment: TradeYieldSegment;
} & Partial<Provenance>;
// Provenance fields optional on row for read-tolerance; required on put-method parameter.
// See persistence-row-provenance.prd.md.

/**
 * Project a persisted `_TradeYieldSegment` to the public `TradeYieldSegment` wire shape.
 * The segment body itself already matches the public type.
 */
export function toTradeYieldSegment(row: _TradeYieldSegment): TradeYieldSegment {
  return row.segment;
}

type SegmentRow = Selectable<TradeYieldSegmentsTable>;
type PortionRow = Selectable<TradeYieldSegmentTransactionPortionsTable>;

/**
 * Map a PG `trade_yield_segments` row + its child `trade_yield_segment_transaction_portions`
 * rows back into a `_TradeYieldSegment` (NUMERIC/BIGINT columns → Number() at the boundary).
 */
export function segmentRowToRecord(row: SegmentRow, portions: PortionRow[]): _TradeYieldSegment {
  const segment: TradeYieldSegment = {
    uuid: row.segment_id as TradeYieldSegmentUUID,
    tradeUuid: row.trade_id as TradeUUID,
    subTradeUuids: row.sub_trade_uuids as SubTradeUUID[],
    archetype: row.archetype as TradeYieldSegment['archetype'],
    denominator: Number(row.denominator),
    startEpoch: Number(row.start_epoch),
    endEpoch: row.end_epoch === null ? null : Number(row.end_epoch),
    startBoundaryKind: row.start_boundary_kind as TradeYieldSegment['startBoundaryKind'],
    endBoundaryKind: row.end_boundary_kind as TradeYieldSegment['endBoundaryKind'],
    transactionPortions: portions.map(p => ({
      transactionUuid: p.transaction_id as TransactionUUID,
      quantityPortion: Number(p.portion),
    })),
    gain: Number(row.gain),
    days: row.days,
    yield: Number(row.yield),
    feesAndCommissions: Number(row.fees_and_commissions),
  };
  if (row.mtm_price_at_boundary !== null) segment.markToMarketPriceAtBoundary = Number(row.mtm_price_at_boundary);
  if (row.explanation !== null) segment.explanation = row.explanation;
  if (row.leaf_chain_uuids !== null) segment.leafChainUuids = row.leaf_chain_uuids as LeafChainUUID[];
  if (row.prior_segment_uuids !== null) segment.priorSegmentUuids = row.prior_segment_uuids as TradeYieldSegmentUUID[];
  if (row.closing_transaction_uuids !== null) segment.closingTransactionUuids = row.closing_transaction_uuids as TransactionUUID[];
  if (row.opening_transaction_uuids !== null) segment.openingTransactionUuids = row.opening_transaction_uuids as TransactionUUID[];
  if (row.family_cluster_id !== null) segment.familyClusterId = row.family_cluster_id;
  if (row.boundary_qty_delta_prior !== null && row.boundary_qty_delta_current !== null) {
    segment.boundaryQuantityDelta = {
      prior: Number(row.boundary_qty_delta_prior),
      current: Number(row.boundary_qty_delta_current),
    };
  }

  const record: _TradeYieldSegment = {
    owner: row.owner as AccountOwner,
    context: row.context as YieldContext,
    tradeUuid: row.trade_id as TradeUUID,
    segment,
  };
  if (row.started_by !== null) record.startedBy = row.started_by;
  if (row.job_id !== null) record.jobId = row.job_id;
  if (row.writer !== null) record.writerLambda = row.writer;
  if (row.writer_version !== null) record.writerVersion = row.writer_version;
  if (row.written_at !== null) record.writtenAt = Number(row.written_at);
  return record;
}
