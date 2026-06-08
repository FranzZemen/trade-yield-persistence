# Usage: `_TradeDailyMTMSeries`

Per-trade daily mark-to-market curve feeding the trade-detail temporal-segment
chart's rich-curve mode. Lazy-populated on first chart view (yield-segment-redesign
E11.5). In Postgres (Era 4 / 4a) this is the `trade_daily_mtm_series` table plus
its child `trade_daily_mtm_archetype_contributions` table.

## Row shape

```typescript
type _TradeDailyMTMSeries = DBRecord & {
  owner: AccountOwner;
  tradeUuid: TradeUUID;                          // trade_id column

  dateEpoch: number;                             // date_epoch — midnight-UTC epoch (BIGINT)
  date: Datestamp;                               // date — ISO 'YYYY-MM-DD' (DATE projected via ::text)

  mtmAmount: number;                             // mtm_amount — signedQty × close × multiplier, summed across legs
  carAtDate: number;                             // car_at_date — capital-at-risk for the day
  segmentArchetypeContributions: SegmentArchetypeContribution[]; // child table rows
  priceCoverage: number;                         // 0..1 — fraction of open exposure with real vendor pricing

  computedAt: number;
} & Partial<Provenance>;                         // NOTE: trade_daily_mtm_series has NO provenance columns

type SegmentArchetypeContribution = {            // one trade_daily_mtm_archetype_contributions row
  archetype: Archetype;                          // longEquity | nakedShortOption | …
  carContribution: number;
};
```

Keyed `(owner, trade_id, date_epoch)`. The bounded `segmentArchetypeContributions[]`
(≤16 archetypes) is the child table `trade_daily_mtm_archetype_contributions`,
keyed `(owner, trade_id, date_epoch, archetype)` and FK'd to the parent
`ON DELETE CASCADE` — there is no jsonb. There is no SK encoding; reads are
`WHERE (owner, trade_id)` ordered by date.

## Producer

`lambda-trade-daily-mtm-populator` (sam-brokenstock-batch). Triggered by a
`TradeDailyMTMPopulatePayload` on `TRADE_DAILY_MTM_POPULATE_QUEUE` (see
`@franzzemen/async-jobs`):

```typescript
type TradeDailyMTMPopulatePayload = {
  tradeUuid: TradeUUID;
  mode: 'full' | 'tail-extend';
};
```

The worker:
1. Loads the trade + transactions.
2. Walks each trading day from the trade's `startEpoch` to `min(now, trade.endEpoch)`.
3. For each day, filters transactions to `≤ endOfDay` and runs `decomposeTradeGains` with `priceSource='historical'`.
4. Idempotently puts one `_TradeDailyMTMSeries` row per trading day via `putDailyMTMRows` (upsert on `(owner, trade_id, date_epoch)`; the row's archetype-contribution children are replaced each write).

`'tail-extend'` appends only missing right-edge days (cheap nightly path; no-op
for closed/complete trades).

## Enqueue sites

| Site | Trigger | Mode |
|---|---|---|
| `trade-yield-aggregate-handler` (sam-brokenstock) | First chart view of a trade with no rows yet | `'full'` |
| Nightly orchestrator | Per active trade with existing rows | `'tail-extend'` |
| Historical-yield-invalidation publisher | Yield-math change wipes affected trades | `'full'` (re-fires after wipe) |

## Consumer

```typescript
const series = await api.queryDailyMTMSeriesForTrade(tradeUuid);
// → _TradeDailyMTMSeries[] ascending by date (children reassembled from the child table)
```

The FE wraps this via `TradeYieldSummariesService.fetchDailyMTMSeries(tradeUuid)`
(broken-stock); the chart renders the step-function default until the series
resolves, then upgrades to the rich curve.

## Watchlist (emergent)

```typescript
const tradeUuids = await api.getDistinctTradeUuidsWithDailyMTM();
```

The nightly tail-extender drives off this list — no separate watchlist table
(`SELECT DISTINCT trade_id … WHERE owner = ?`). A trade is "engaged" iff it has
at least one row.

## Cascade & invalidation

- Deleting the trade row sweeps the series via FK `ON DELETE CASCADE`; the archetype-contribution children cascade off the parent series rows.
- `deleteByTrade(tradeUuid)` and `deleteDailyMTMSeriesForTrade(tradeUuid)` delete the series explicitly for invalidation (children cascade via FK).
- Historical-yield-invalidation pipeline calls `deleteDailyMTMSeriesForTrade` on yield-math change.
- Engaged trades re-populate on next chart view.

## See also

- `~/dev/brokenstock-orchestrator/doc/prd/yield-segment-redesign.prd.md` E11.5.
- `~/dev/brokenstock-orchestrator/doc/usage/trade-daily-mtm-populator.usage.md` — the producer orchestrator.
- `~/dev/yield` `decomposeTradeGains` — the per-day computation.
</content>
