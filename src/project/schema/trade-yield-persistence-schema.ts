/*
Created by Franz Zemen 05/11/2026
License Type: UNLICENSED
*/

import {Dynamo, ProgressCallback, SchemaSequence} from '@franzzemen/aws-app/dynamo';
import {ExecutionContext} from '@franzzemen/execution-context';
import {merge} from '@franzzemen/utility';

// Table-name constants for the trade-level yield-segment persistence model
// (yield-segment-redesign PRD E8). Five tables: per-segment + per-sub-trade-unit fact
// rows under three "contexts" (open | asOf:<date> | since:<epoch>), plus three summary
// tables that hold the trade-level PSCaR aggregation per context with segment/unit-uuid
// references back to the fact tables.
export const TRADE_YIELD_SEGMENTS = 'TRADE_YIELD_SEGMENTS';
export const SUB_TRADE_YIELD_UNITS = 'SUB_TRADE_YIELD_UNITS';
export const OPEN_TRADE_YIELD_SUMMARIES = 'OPEN_TRADE_YIELD_SUMMARIES';
export const AS_OF_TRADE_YIELD_SUMMARIES = 'AS_OF_TRADE_YIELD_SUMMARIES';
export const SINCE_TRADE_YIELD_SUMMARIES = 'SINCE_TRADE_YIELD_SUMMARIES';
// E11.5: lazy-populated daily MTM series for the FE temporal-segment chart.
// One row per (owner, tradeUuid, dateEpoch). Watchlist for the nightly
// tail-extender is emergent from distinct tradeUuid values in this table.
export const TRADE_DAILY_MTM_SERIES = 'TRADE_DAILY_MTM_SERIES';

// LSI name shared by every table that needs per-trade drill-down across owner-partition.
export const BY_TRADE_INDEX = 'byTrade-index';

// No TTL on any table. Trade-yield rows are removed via cascade-delete keyed by tradeUuid
// (when a trade rotates uuid, is deleted, or is invalidated by a backdated import).

const tradeYieldPersistenceSchema: SchemaSequence = {
  create: [
    {
      // Per-segment fact rows under one of three context prefixes.
      // Base SK is context-first so "all open segments for owner", "all as-of:DATE segments
      // for owner", "all since:EPOCH segments for owner" are all single-Query prefix-scans.
      // LSI BY_TRADE_INDEX is trade-first so "every segment for one trade (across contexts
      // OR within one context)" is also a single Query. Cascade-delete by trade uuid uses
      // the LSI.
      TableName: TRADE_YIELD_SEGMENTS,
      AttributeDefinitions: [
        {AttributeName: 'owner', AttributeType: 'S'},
        {AttributeName: 'contextTradeStartSk', AttributeType: 'S'},
        {AttributeName: 'tradeContextStartSk', AttributeType: 'S'}
      ],
      KeySchema: [
        {AttributeName: 'owner', KeyType: 'HASH'},
        {AttributeName: 'contextTradeStartSk', KeyType: 'RANGE'}
      ],
      LocalSecondaryIndexes: [
        {
          IndexName: BY_TRADE_INDEX,
          KeySchema: [
            {AttributeName: 'owner', KeyType: 'HASH'},
            {AttributeName: 'tradeContextStartSk', KeyType: 'RANGE'}
          ],
          Projection: {ProjectionType: 'ALL'}
        }
      ],
      BillingMode: 'PAY_PER_REQUEST',
      DeletionProtectionEnabled: true,
      TableClass: 'STANDARD'
    },
    {
      // Per-sub-trade-yield-unit fact rows. Same context-first SK strategy as segments.
      TableName: SUB_TRADE_YIELD_UNITS,
      AttributeDefinitions: [
        {AttributeName: 'owner', AttributeType: 'S'},
        {AttributeName: 'contextTradeSubTradeUnitSk', AttributeType: 'S'},
        {AttributeName: 'tradeContextSubTradeUnitSk', AttributeType: 'S'}
      ],
      KeySchema: [
        {AttributeName: 'owner', KeyType: 'HASH'},
        {AttributeName: 'contextTradeSubTradeUnitSk', KeyType: 'RANGE'}
      ],
      LocalSecondaryIndexes: [
        {
          IndexName: BY_TRADE_INDEX,
          KeySchema: [
            {AttributeName: 'owner', KeyType: 'HASH'},
            {AttributeName: 'tradeContextSubTradeUnitSk', KeyType: 'RANGE'}
          ],
          Projection: {ProjectionType: 'ALL'}
        }
      ],
      BillingMode: 'PAY_PER_REQUEST',
      DeletionProtectionEnabled: true,
      TableClass: 'STANDARD'
    },
    {
      // Open-trade yield summary — one row per (owner, tradeUuid). PSCaR + total gain +
      // segment uuid references. No LSI needed; tradeUuid IS the SK.
      TableName: OPEN_TRADE_YIELD_SUMMARIES,
      AttributeDefinitions: [
        {AttributeName: 'owner', AttributeType: 'S'},
        {AttributeName: 'tradeUuid', AttributeType: 'S'}
      ],
      KeySchema: [
        {AttributeName: 'owner', KeyType: 'HASH'},
        {AttributeName: 'tradeUuid', KeyType: 'RANGE'}
      ],
      BillingMode: 'PAY_PER_REQUEST',
      DeletionProtectionEnabled: true,
      TableClass: 'STANDARD'
    },
    {
      // As-of trade yield summary — one row per (owner, asOfDate, tradeUuid).
      // Base SK asOfDate-first → "every as-of trade summary for owner on one date" in one Query.
      // LSI tradeUuid-first → "every as-of date for one trade" + cascade-delete-by-trade.
      TableName: AS_OF_TRADE_YIELD_SUMMARIES,
      AttributeDefinitions: [
        {AttributeName: 'owner', AttributeType: 'S'},
        {AttributeName: 'asOfDateTradeUuidSk', AttributeType: 'S'},
        {AttributeName: 'tradeUuidAsOfDateSk', AttributeType: 'S'}
      ],
      KeySchema: [
        {AttributeName: 'owner', KeyType: 'HASH'},
        {AttributeName: 'asOfDateTradeUuidSk', KeyType: 'RANGE'}
      ],
      LocalSecondaryIndexes: [
        {
          IndexName: BY_TRADE_INDEX,
          KeySchema: [
            {AttributeName: 'owner', KeyType: 'HASH'},
            {AttributeName: 'tradeUuidAsOfDateSk', KeyType: 'RANGE'}
          ],
          Projection: {ProjectionType: 'ALL'}
        }
      ],
      BillingMode: 'PAY_PER_REQUEST',
      DeletionProtectionEnabled: true,
      TableClass: 'STANDARD'
    },
    {
      // Since trade yield summary — one row per (owner, sinceAnchorEpoch, tradeUuid).
      // Anchor-epoch is zero-padded to 13 digits so lexicographic = numeric order.
      // Base SK anchor-first; LSI trade-first.
      TableName: SINCE_TRADE_YIELD_SUMMARIES,
      AttributeDefinitions: [
        {AttributeName: 'owner', AttributeType: 'S'},
        {AttributeName: 'sinceAnchorTradeUuidSk', AttributeType: 'S'},
        {AttributeName: 'tradeUuidSinceAnchorSk', AttributeType: 'S'}
      ],
      KeySchema: [
        {AttributeName: 'owner', KeyType: 'HASH'},
        {AttributeName: 'sinceAnchorTradeUuidSk', KeyType: 'RANGE'}
      ],
      LocalSecondaryIndexes: [
        {
          IndexName: BY_TRADE_INDEX,
          KeySchema: [
            {AttributeName: 'owner', KeyType: 'HASH'},
            {AttributeName: 'tradeUuidSinceAnchorSk', KeyType: 'RANGE'}
          ],
          Projection: {ProjectionType: 'ALL'}
        }
      ],
      BillingMode: 'PAY_PER_REQUEST',
      DeletionProtectionEnabled: true,
      TableClass: 'STANDARD'
    },
    {
      // Daily MTM series — one row per (owner, tradeUuid, dateEpoch). The chart
      // reads all rows for one trade via base-SK prefix scan `'${tradeUuid}#'`.
      // No LSI needed: every read path is per-trade, and the nightly tail-extender
      // derives its watchlist by scanning distinct tradeUuid values from the base.
      TableName: TRADE_DAILY_MTM_SERIES,
      AttributeDefinitions: [
        {AttributeName: 'owner', AttributeType: 'S'},
        {AttributeName: 'tradeDateSk', AttributeType: 'S'}
      ],
      KeySchema: [
        {AttributeName: 'owner', KeyType: 'HASH'},
        {AttributeName: 'tradeDateSk', KeyType: 'RANGE'}
      ],
      BillingMode: 'PAY_PER_REQUEST',
      DeletionProtectionEnabled: true,
      TableClass: 'STANDARD'
    }
  ],
  updates: []
};

/**
 * @iam dynamodb:CreateTable
 * @iam dynamodb:DeleteTable
 * @iam dynamodb:DescribeTable
 * @iam dynamodb:UpdateTable
 * @iam dynamodb:UpdateTimeToLive
 */

export async function updateTradeYieldPersistenceSchema(ec: ExecutionContext, callback?: ProgressCallback): Promise<void> {
  const dynamo = new Dynamo(ec, 'dynamodb-admin');
  await dynamo.updateSchema(merge({} as SchemaSequence, tradeYieldPersistenceSchema), callback);
}
