# @franzzemen/trade-yield-persistence

Aurora Postgres persistence layer (a pure kysely store) for the trade-yield-segment model (yield-segment-redesign PRD, 2026-05-12). Owns the row records, key/context helpers, projection helpers, and `TradeYieldPersistenceTrustedApi` over the eight tables that back trade-scope yield: segment + sub-trade-unit fact rows, open/as-of/since trade-level PSCaR summaries, and the per-trade daily MTM series. The DDL lives in `@franzzemen/brokenstock-postgres-ddl` (migration `2026-06-08T120000Z_era_4_4a_yield_persistence`); this package consumes the generated kysely `Database` types and never issues DDL itself.

Replaces the legacy `@franzzemen/as-of-yields`, `@franzzemen/since-yields`, and `@franzzemen/yield-snapshots` packages (retired per yield-segment-redesign E16).

## Tables

The six logical entities are relationalized into eight Postgres tables (the two
unbounded/bounded child arrays each get their own child table). Full keying and
index detail live in the [guide](doc/guide/trade-yield-persistence.guide.md).

| Table | Purpose | Key |
|---|---|---|
| `trade_yield_segments` | Per-segment fact rows under three contexts (`open` / `asOf:<date>` / `since:<epoch>`) | `segment_id` PK; `(owner, trade_id, context)` index |
| `trade_yield_segment_transaction_portions` | Child of segment: the unbounded `transactionPortions[]`, FK'd to `transactions` | `(segment_id, transaction_id)` PK |
| `sub_trade_yield_units` | Per-symbol forensic units ("as-if-no-spread") under the same three contexts | `unit_id` PK; `(owner, trade_id, context)` index |
| `open_trade_yield_summaries` | One trade-level PSCaR summary per open trade | `(owner, trade_id)` PK |
| `as_of_trade_yield_summaries` | One PSCaR summary per `(trade, asOfDate)` | `(owner, trade_id, as_of_date)` PK; `(owner, as_of_date)` index |
| `since_trade_yield_summaries` | One PSCaR summary per `(trade, sinceAnchorEpoch)` | `(owner, trade_id, since_anchor_epoch)` PK |
| `trade_daily_mtm_series` | Lazy-populated daily MTM curve per trade (E11.5) | `(owner, trade_id, date_epoch)` PK |
| `trade_daily_mtm_archetype_contributions` | Child of daily-MTM: the bounded `segmentArchetypeContributions[]` | `(owner, trade_id, date_epoch, archetype)` PK |

Every fact-bearing table FKs `trades(trade_id) ON DELETE CASCADE`; the two child
tables FK their parent `ON DELETE CASCADE`. No TTL — rows leave only via cascade
or explicit invalidation, never by clock. Zero jsonb (relational migration discipline).

## Documentation

| Document | Audience | Description |
|---|---|---|
| [Intent](doc/intent/trade-yield-persistence.intent.md) | AI agents | Why this package owns persistence; context model; cascade contract |
| [Guide](doc/guide/trade-yield-persistence.guide.md) | Maintainers | Table layout, context model, projection helpers, adding a context |
| [Usage](doc/usage/trade-yield-persistence.usage.md) | Consumers | `TradeYieldPersistenceTrustedApi` method reference + examples |
| [Daily MTM Series](doc/usage/trade-daily-mtm-series.usage.md) | Consumers | `_TradeDailyMTMSeries` read/write contract used by the FE chart |

## Core Concepts

- **Three contexts, one set of fact tables.** Segments + sub-trade units carry a `context: YieldContext` discriminator (`'open' | 'asOf:<date>' | 'since:<epoch>'`). The same trade can have parallel segment sets under each. `context` is a real CHECK-constrained `TEXT` column; every fact read is `WHERE (owner, trade_id, context)`.
- **Trusted, not endpoint.** Every method assumes a synthetic session owner is present on the `ExecutionContext` — callers are server-side orchestrators / workers, never REST handlers operating on caller-trusted input.
- **Cascade-delete is FK-driven + package-owned.** Deleting a `trades` row auto-sweeps all yield rows via FK `ON DELETE CASCADE`. For *invalidation* (clearing derived rows without deleting the trade), `deleteByTrade(tradeUuid)` sweeps every row across all tables — orchestrator-side trade/account/import deletion paths call this single method.
- **Projections are explicit.** `_TradeYieldSegment` etc. are persisted shapes; `toTradeYieldSegment(row)` / `toTradeYieldSegmentSummary(row)` produce wire-public shapes that strip `owner`, denormalized keys, and audit fields.
- **Same-day batching invariant** (see `@franzzemen/yield`): two transactions on the same `tradingDate` are persisted as one segment boundary, not two — the upstream walker decides; this package only stores.

## Cross-references

- `~/dev/brokenstock-orchestrator/doc/prd/yield-segment-redesign.prd.md` — full design + E8 epic.
- `@franzzemen/yield` `decomposeTradeGains` + `evaluateTradeYieldSegments` + `aggregateTradeYieldSummary` — the compute side.
- `@franzzemen/financial-identity` — public types (`TradeYieldSegment`, `SubTradeYieldUnit`, `TradeYieldSegmentSummary`, `Archetype`, `SegmentBoundaryKind`).
