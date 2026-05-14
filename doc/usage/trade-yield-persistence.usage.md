# Usage: trade-yield-persistence

`TradeYieldPersistenceTrustedApi` is a trusted (server-side) API. Construct it with an `ExecutionContext` that carries a synthetic session owner; every method scopes I/O to that owner.

```typescript
import {ExecutionContext} from '@franzzemen/execution-context';
import {TradeYieldPersistenceTrustedApi} from '@franzzemen/trade-yield-persistence';

const api = new TradeYieldPersistenceTrustedApi(ec);
```

## Fact-row writes

```typescript
// Segments (one row per evaluated segment, under the supplied context).
await api.putSegmentRows([
  {owner, context: 'open', tradeUuid, contextTradeStartSk: '…', tradeContextStartSk: '…', segment}
]);

// Sub-trade yield units (per-symbol forensic view).
await api.putSubTradeYieldUnitRows([...]);
```

Both methods are idempotent batch upserts. Build the SK fields via the encoders in `identity/_trade-yield-segment.ts` and `identity/_sub-trade-yield-unit.ts`.

## Fact-row reads

```typescript
// All segments for a (trade, context) — driven by the byTrade-index LSI.
const segments = await api.getSegmentRowsForTradeAndContext(tradeUuid, 'open');

// All sub-trade yield units for a (trade, context).
const units = await api.getSubTradeYieldUnitRowsForTradeAndContext(tradeUuid, 'asOf:2026-04-15');
```

## Summary writes

```typescript
// Open trade summary — one row per (owner, tradeUuid).
await api.putOpenTradeSummary(summary);                              // TradeYieldSegmentSummary

// As-of summary — one row per (owner, asOfDate, tradeUuid).
await api.putAsOfTradeSummary(summary, asOfDate);                    // AsOfTradeYieldSegmentSummary

// Since summary — one row per (owner, sinceAnchorEpoch, tradeUuid).
await api.putSinceTradeSummary(summary, sinceAnchorEpoch);
```

`priceCoverage` + `recomputeAttempts` are persisted on `_OpenTradeYieldSummary` and hydrated on read (E11.7).

## Summary reads

```typescript
const open    = await api.getOpenTradeSummary(tradeUuid);                     // TradeYieldSegmentSummary | undefined
const asOf    = await api.getAsOfTradeSummary(tradeUuid, '2026-04-15');       // AsOfTradeYieldSegmentSummary | undefined
const since   = await api.getSinceTradeSummary(tradeUuid, anchorEpoch);
const allOpen = await api.getAllOpenTradeSummaryRows();                       // every open trade for owner (nightly rollup)

// Time-series fan-out
const asOfHistory = await api.getAsOfTradeSummaryRowsForTrade(tradeUuid, {from: '2026-01-01'});
const dailyByDate = await api.getAsOfTradeSummaryRowsForOwnerAndDate('2026-04-15');
```

## Daily MTM series (E11.5)

```typescript
// Write — populator emits one row per trading day.
await api.putDailyMTMRows([...]);

// Read — chart consumes the full curve for one trade.
const series = await api.queryDailyMTMSeriesForTrade(tradeUuid);

// Watchlist for nightly tail-extender.
const tradeUuids = await api.getDistinctTradeUuidsWithDailyMTM();

// Wipe (invalidation pipeline; lazy repopulate on next view).
const deleted = await api.deleteDailyMTMSeriesForTrade(tradeUuid);
```

## Cascade delete

```typescript
// Single call sweeps every row across all six tables for the trade.
// Callers MUST use this — do not call per-table delete methods directly.
const deleted = await api.deleteByTrade(tradeUuid);
```

Wired into:
- `brokenstock-orchestrator/trade-deletion-orchestrator`
- `brokenstock-orchestrator/account-deletion-orchestrator`
- `brokenstock-orchestrator/file-import-action-orchestrator` (unprocess path)

## Partial deletes (specialized)

These exist for in-place invalidation flows. Most callers should prefer `deleteByTrade`.

```typescript
await api.deleteFactRowsByTradeAndContext(tradeUuid, 'asOf:2026-04-15');
await api.deleteOpenTradeRowsByTrade(tradeUuid);
await api.deleteAsOfSummariesByTradeAndDateRange(tradeUuid, '2026-04-01');
await api.deleteSinceSummariesByTradeAndAnchorRange(tradeUuid, fromEpoch);
```

## Type re-exports

The package re-exports `Archetype`, `SegmentBoundaryKind`, `TradeYieldSegment`, `TradeYieldSegmentSummary`, etc. from `@franzzemen/financial-identity` for caller convenience. The authoritative source is still `financial-identity`.

## See also

- [Daily MTM Series usage](./trade-daily-mtm-series.usage.md)
- [Intent](../intent/trade-yield-persistence.intent.md)
- [Guide](../guide/trade-yield-persistence.guide.md)
