/*
Created by Franz Zemen 05/11/2026
License Type: UNLICENSED
*/

import {Provenance} from '@franzzemen/admin-identity';
import {DBRecord} from '@franzzemen/endpoint-application';
import {AccountOwner} from '@franzzemen/endpoint-financial-identity';
import {SubTradeUUID, SubTradeYieldUnit, SubTradeYieldUnitUUID, TradeUUID} from '@franzzemen/financial-identity';
import {YieldContext} from './yield-context.js';

/**
 * Persisted forensic per-sub-trade "as-if-no-spread" yield-unit row. One row per
 * `SubTradeYieldUnit` under a context-scoped key (mirrors `_TradeYieldSegment` layout).
 *
 * SK strategy:
 * - `contextTradeSubTradeUnitSk = '${context}#${tradeUuid}#${subTradeUuid}#${unitUuid}'`
 *   Base RANGE. Prefix `'${context}#${tradeUuid}#'` returns every unit for one trade in one context.
 * - `tradeContextSubTradeUnitSk = '${tradeUuid}#${context}#${subTradeUuid}#${unitUuid}'`
 *   BY_TRADE_INDEX LSI. Prefix `'${tradeUuid}#'` covers all contexts for trade (cascade).
 */
export type _SubTradeYieldUnit = DBRecord & {
  owner: AccountOwner;
  context: YieldContext;
  tradeUuid: TradeUUID;
  subTradeUuid: SubTradeUUID;
  contextTradeSubTradeUnitSk: string;
  tradeContextSubTradeUnitSk: string;
  unit: SubTradeYieldUnit;
} & Partial<Provenance>;
// Provenance fields optional on row for read-tolerance; required on put-method parameter.
// See persistence-row-provenance.prd.md.

export function makeContextTradeSubTradeUnitSk(
  context: YieldContext,
  tradeUuid: TradeUUID,
  subTradeUuid: SubTradeUUID,
  unitUuid: SubTradeYieldUnitUUID,
): string {
  return `${context}#${tradeUuid}#${subTradeUuid}#${unitUuid}`;
}

export function makeTradeContextSubTradeUnitSk(
  tradeUuid: TradeUUID,
  context: YieldContext,
  subTradeUuid: SubTradeUUID,
  unitUuid: SubTradeYieldUnitUUID,
): string {
  return `${tradeUuid}#${context}#${subTradeUuid}#${unitUuid}`;
}

export function toSubTradeYieldUnit(row: _SubTradeYieldUnit): SubTradeYieldUnit {
  return row.unit;
}
