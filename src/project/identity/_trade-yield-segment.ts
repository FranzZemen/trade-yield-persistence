/*
Created by Franz Zemen 05/11/2026
License Type: UNLICENSED
*/

import {Provenance} from '@franzzemen/admin-identity';
import {DBRecord} from '@franzzemen/endpoint-application';
import {AccountOwner} from '@franzzemen/endpoint-financial-identity';
import {TradeYieldSegment, TradeYieldSegmentUUID, TradeUUID} from '@franzzemen/financial-identity';
import {padEpoch, YieldContext} from './yield-context.js';

/**
 * Persisted per-segment fact row. Stores one `TradeYieldSegment` under a context-scoped key
 * so the same trade can have multiple sets of segments (open + per-as-of-date + per-since-
 * anchor) without collision.
 *
 * SK strategy:
 * - `contextTradeStartSk = '${context}#${tradeUuid}#${padEpoch(startEpoch)}#${segmentUuid}'`
 *   Base RANGE. "Every segment in one context for this owner" = prefix scan `'${context}#'`.
 * - `tradeContextStartSk = '${tradeUuid}#${context}#${padEpoch(startEpoch)}#${segmentUuid}'`
 *   BY_TRADE_INDEX LSI RANGE. "Every segment for this trade" = prefix `'${tradeUuid}#'`;
 *   "Every segment for this (trade, context)" = prefix `'${tradeUuid}#${context}#'`.
 *
 * Cascade contract:
 * - Trade uuid rotation or trade deletion → cascade-delete by `tradeContextStartSk` LSI
 *   prefix `'${tradeUuid}#'` (sweeps every context for that trade).
 * - Per-context invalidation (e.g., backdated import invalidates open + as-of from D forward)
 *   → cascade-delete by `contextTradeStartSk` prefix.
 */
export type _TradeYieldSegment = DBRecord & {
  owner: AccountOwner;
  context: YieldContext;
  tradeUuid: TradeUUID;
  contextTradeStartSk: string;
  tradeContextStartSk: string;
  segment: TradeYieldSegment;
} & Partial<Provenance>;
// Provenance fields optional on row for read-tolerance; required on put-method parameter.
// See persistence-row-provenance.prd.md.

export function makeContextTradeStartSk(context: YieldContext, tradeUuid: TradeUUID, startEpoch: number, segmentUuid: TradeYieldSegmentUUID): string {
  return `${context}#${tradeUuid}#${padEpoch(startEpoch)}#${segmentUuid}`;
}

export function makeTradeContextStartSk(tradeUuid: TradeUUID, context: YieldContext, startEpoch: number, segmentUuid: TradeYieldSegmentUUID): string {
  return `${tradeUuid}#${context}#${padEpoch(startEpoch)}#${segmentUuid}`;
}

/**
 * Project a persisted `_TradeYieldSegment` to the public `TradeYieldSegment` wire shape.
 * Drops owner + DDB-key denormalizations + audit fields; the segment body itself already
 * matches the public type.
 */
export function toTradeYieldSegment(row: _TradeYieldSegment): TradeYieldSegment {
  return row.segment;
}
