# Usage: trade-yield-persistence

`TradeYieldPersistenceTrustedApi` is a trusted (server-side) API over Aurora
Postgres (kysely). Construct it with an `ExecutionContext` carrying a synthetic
session owner AND the `Kysely<Database>` instance; every method scopes I/O to
that owner via `getSessionOwner(ec)`.

```typescript
import {Kysely} from 'kysely';
import {ExecutionContext} from '@franzzemen/execution-context';
import type {Database} from '@franzzemen/brokenstock-postgres-ddl/schema-types';
import {TradeYieldPersistenceTrustedApi} from '@franzzemen/trade-yield-persistence';

const api = new TradeYieldPersistenceTrustedApi(ec, db); // db: Kysely<Database>
```

Every `put*` requires a `Provenance` argument; it is stamped onto each written
row (`putDailyMTMRows` accepts it for parity but the daily-MTM table has no
provenance columns).

## Fact-row writes

```typescript
// Segments — one row per evaluated segment, under the supplied context.
// Each segment.uuid (the PK) and context must be populated; buildSegmentRow does this.
const segRows = segments.map(s => api.buildSegmentRow('open', s));
await api.putSegmentRows(segRows, provenance);

// Sub-trade yield units (per-symbol forensic view).
const unitRows = units.map(u => api.buildSubTradeYieldUnitRow('open', u));
await api.putSubTradeYieldUnitRows(unitRows, provenance);
```

`putSegmentRows` writes the segment's scalar columns AND its `transactionPortions[]`
into the child `trade_yield_segment_transaction_portions` table. Both methods are
batch upserts.

## Fact-row reads

```typescript
// All segments for a (trade, context) — WHERE (owner, trade_id, context).
// Reassembles each segment's transactionPortions[] from the child table.
const segments = await api.getSegmentRowsForTradeAndContext(tradeUuid, 'open');

// All sub-trade yield units for a (trade, context).
const units = await api.getSubTradeYieldUnitRowsForTradeAndContext(tradeUuid, 'asOf:2026-04-15');
```

## Summary writes

Each summary write is atomic: it replaces the context's fact rows (segments +
units) then upserts the summary row.

```typescript
// Open trade summary — one row per (owner, trade_id).
await api.putOpenTradeSummary(summary, provenance);                        // TradeYieldSegmentSummary
await api.putOpenTradeSummary(summary, provenance, {existsCheck});         // skip if trade gone (OrphanTradeError)

// As-of summary — one row per (owner, trade_id, as_of_date).
await api.putAsOfTradeSummary(summary, provenance);                        // AsOfTradeYieldSegmentSummary
await api.putAsOfTradeSummary(summary, provenance, {existsCheck});

// Since summary — one row per (owner, trade_id, since_anchor_epoch).
await api.putSinceTradeSummary(summary, provenance);
```

`existsCheck` (open + as-of only) runs before any write; if it returns false the
call throws `OrphanTradeError` and persists nothing — catch it with
`isOrphanTradeError(err)` and treat as a benign skip.

## Summary reads

```typescript
const open    = await api.getOpenTradeSummary(tradeUuid);                     // TradeYieldSegmentSummary | undefined (no lineage)
const openFull= await api.getOpenTradeSummary(tradeUuid, {includeLineage: true}); // hydrates summary.lineageGraph (managed rolls)
const asOf    = await api.getAsOfTradeSummary(tradeUuid, '2026-04-15');       // AsOfTradeYieldSegmentSummary | undefined
const since   = await api.getSinceTradeSummary(tradeUuid, anchorEpoch);
const allOpen = await api.getAllOpenTradeSummaryRows();                       // every open-trade summary row for owner (no hydration)

// Time-series fan-out (summary rows only, no segment hydration)
const asOfHistory = await api.getAsOfTradeSummaryRowsForTrade(tradeUuid, {from: '2026-01-01'});
const dailyByDate = await api.getAsOfTradeSummaryRowsForOwnerAndDate('2026-04-15'); // uses the (owner, as_of_date) index
```

The composite reads (`getOpenTradeSummary` / `getAsOfTradeSummary` /
`getSinceTradeSummary`) hydrate the summary row + its segments + units into the
public DTO. The `…RowsFor…` reads return summary scalar rows only.

### Managed-roll lineage (`lineage_graph`)

`putOpenTradeSummary` persists `summary.lineageGraph` (the managed-roll split/merge/roll
DAG, present only for option-bearing trades) to the `open_trade_yield_summaries.lineage_graph`
**jsonb** column. This is the one deliberate exception to era-4-4a's ZERO-jsonb rule:
the graph is **render-only** — the FE Managed Rolls tab reads it whole; nothing runs SQL
over its internals (gains/portions stay relational), so it never needs to be queryable.

Hydration is **opt-in** to keep list/batch reads lean (D6):

- `getOpenTradeSummary(uuid, {includeLineage: true})` — selects + hydrates `lineageGraph`.
  The orchestrator's single-trade read (`getStoredTradeYield`) passes this.
- `getOpenTradeSummary(uuid)` (default) — does **not** select the column, so the batch
  path (`getStoredBatchTradeYields`) never detoasts lineage for the trade list.

Equity-only trades have no `lineageGraph` (round-trips as `undefined`).

## Admin / provenance helpers

```typescript
const stale  = await api.findStaleOpenTradeSummaries(cutoffEpoch);            // writtenAt < cutoff or missing
const groups = await api.groupOpenSummariesByProvenance('writerLambda');      // | 'startedBy' | 'writerVersion'
```

## Daily MTM series (E11.5)

```typescript
// Write — one row per trading day; also replaces the row's archetype-contribution children.
await api.putDailyMTMRows(rows, provenance);

// Read — full curve for one trade, ascending by date (children reassembled).
const series = await api.queryDailyMTMSeriesForTrade(tradeUuid);

// Watchlist for nightly tail-extender.
const tradeUuids = await api.getDistinctTradeUuidsWithDailyMTM();

// Wipe (invalidation; lazy repopulate on next view). Children cascade via FK.
const deleted = await api.deleteDailyMTMSeriesForTrade(tradeUuid);
```

## Cascade delete

A trade row deleted in `financials.trades` auto-sweeps every yield row via FK
`ON DELETE CASCADE`. For *invalidation* (clearing derived rows without deleting
the trade), use the explicit sweep:

```typescript
// Single call deletes every persistence-layer row across all tables for the trade
// (segments, units, all three summaries, daily-MTM; children cascade via FK).
// Callers MUST use this — do not call per-table delete methods directly.
const {deleted, asOfDatesTouched} = await api.deleteByTrade(tradeUuid);
// Chain the gain-snapshots cascade for the touched dates:
//   await gainSnapshotsApi.deleteAsOfRowsForDates(asOfDatesTouched);
```

Wired into:
- `brokenstock-orchestrator/trade-deletion-orchestrator`
- `brokenstock-orchestrator/account-deletion-orchestrator`
- `brokenstock-orchestrator/file-import-action-orchestrator` (unprocess path)

## Partial deletes (specialized)

These exist for in-place invalidation flows. Most callers should prefer `deleteByTrade`.

```typescript
await api.deleteFactRowsByTradeAndContext(tradeUuid, 'asOf:2026-04-15');   // segments + units for one context
await api.deleteOpenTradeRowsByTrade(tradeUuid);                          // open facts + open summary
await api.deleteAsOfSummariesByTradeAndDateRange(tradeUuid, '2026-04-01'); // as-of summaries + facts, asOfDate >= from
await api.deleteSinceSummariesByTradeAndAnchorRange(tradeUuid, fromEpoch); // since summaries + facts, anchor >= from
```

Each returns the number of rows deleted (segment portion + archetype-contribution
children cascade via their own FKs).

## Type re-exports

The package re-exports `OPEN_CONTEXT`, `asOfContext`, `sinceContext`, and
`padEpoch`. Public wire shapes (`TradeYieldSegment`, `TradeYieldSegmentSummary`,
`Archetype`, `SegmentBoundaryKind`, `SubTradeYieldUnit`, etc.) come from
`@franzzemen/financial-identity` — the authoritative source.

## See also

- [Daily MTM Series usage](./trade-daily-mtm-series.usage.md)
- [Intent](../intent/trade-yield-persistence.intent.md)
- [Guide](../guide/trade-yield-persistence.guide.md)
</content>
