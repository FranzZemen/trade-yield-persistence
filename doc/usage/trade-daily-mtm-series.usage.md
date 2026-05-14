# Usage: `_TradeDailyMTMSeries`

Per-trade daily mark-to-market curve feeding the trade-detail temporal-segment chart's rich-curve mode. Lazy-populated on first chart view (yield-segment-redesign E11.5).

## Row shape

```typescript
type _TradeDailyMTMSeries = DBRecord & {
  owner: AccountOwner;
  tradeUuid: TradeUUID;
  tradeDateSk: string;              // `${tradeUuid}#${padEpoch(dateEpoch)}` — base SK

  dateEpoch: number;                // midnight-UTC epoch
  date: Datestamp;                  // ISO 'YYYY-MM-DD' (denormalized for FE)

  mtmAmount: number;                // signedQty × close × multiplier, summed across legs
  carAtDate: number;                // capital-at-risk for the day
  segmentArchetypeContributions: SegmentArchetypeContribution[];
  priceCoverage: number;            // 0..1 — fraction of open exposure with real vendor pricing

  computedAt: number;
};

type SegmentArchetypeContribution = {
  archetype: Archetype;             // longEquity | nakedShortOption | …
  carContribution: number;
};
```

## Producer

`lambda-trade-daily-mtm-populator` (sam-brokenstock-batch). Triggered by a `TradeDailyMTMPopulatePayload` on `TRADE_DAILY_MTM_POPULATE_QUEUE` (see `@franzzemen/async-jobs`):

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
4. Idempotently puts one `_TradeDailyMTMSeries` row per trading day via `putDailyMTMRows`.

`'tail-extend'` appends only missing right-edge days (cheap nightly path; no-op for closed/complete trades).

## Enqueue sites

| Site | Trigger | Mode |
|---|---|---|
| `trade-yield-aggregate-handler` (sam-brokenstock) | First chart view of a trade with no rows yet | `'full'` |
| Nightly orchestrator | Per active trade with existing rows | `'tail-extend'` |
| Historical-yield-invalidation publisher | Yield-math change wipes affected trades | `'full'` (re-fires after wipe) |

## Consumer

```typescript
const series = await api.queryDailyMTMSeriesForTrade(tradeUuid);
// → _TradeDailyMTMSeries[] ascending by date
```

The FE wraps this via `TradeYieldSummariesService.fetchDailyMTMSeries(tradeUuid)` (broken-stock); the chart renders the step-function default until the series resolves, then upgrades to the rich curve.

## Watchlist (emergent)

```typescript
const tradeUuids = await api.getDistinctTradeUuidsWithDailyMTM();
```

The nightly tail-extender drives off this list — no separate watchlist table. A trade is "engaged" iff it has at least one row.

## Cascade & invalidation

- `deleteByTrade(tradeUuid)` wipes the prefix `'${tradeUuid}#'`.
- Historical-yield-invalidation pipeline (shipped 2026-05-08) calls `deleteDailyMTMSeriesForTrade` on yield-math change.
- Engaged trades re-populate on next chart view.

## See also

- `~/dev/brokenstock-orchestrator/doc/prd/yield-segment-redesign.prd.md` E11.5.
- `~/dev/brokenstock-orchestrator/doc/usage/trade-daily-mtm-populator.usage.md` — the producer orchestrator.
- `~/dev/yield` `decomposeTradeGains` — the per-day computation.
