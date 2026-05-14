# @franzzemen/trade-yield-persistence

DynamoDB persistence layer for the trade-yield-segment model (yield-segment-redesign PRD, 2026-05-12). Owns the schema, key encoders, and `TradeYieldPersistenceTrustedApi` for all six tables that back trade-scope yield: segment + sub-trade-unit fact rows, open/as-of/since trade-level PSCaR summaries, and the per-trade daily MTM series.

Replaces the legacy `@franzzemen/as-of-yields`, `@franzzemen/since-yields`, and `@franzzemen/yield-snapshots` packages (retired per yield-segment-redesign E16).

## Tables

| Table | Purpose | Keying |
|---|---|---|
| `TRADE_YIELD_SEGMENTS` | Per-segment fact rows under three contexts (`open` / `asOf:<date>` / `since:<epoch>`) | PK `owner`; SK `contextTradeStartSk`; LSI `byTrade-index` on `tradeContextStartSk` |
| `SUB_TRADE_YIELD_UNITS` | Per-symbol forensic units ("as-if-no-spread") under the same three contexts | PK `owner`; SK `contextTradeSubTradeUnitSk`; LSI `byTrade-index` on `tradeContextSubTradeUnitSk` |
| `OPEN_TRADE_YIELD_SUMMARIES` | One trade-level PSCaR summary per open trade | PK `owner`; SK `tradeUuid` |
| `AS_OF_TRADE_YIELD_SUMMARIES` | One PSCaR summary per `(trade, asOfDate)` | PK `owner`; SK `asOfDateTradeUuidSk`; LSI on `tradeUuidAsOfDateSk` |
| `SINCE_TRADE_YIELD_SUMMARIES` | One PSCaR summary per `(trade, sinceAnchorEpoch)` | PK `owner`; SK `sinceAnchorTradeUuidSk`; LSI on `tradeUuidSinceAnchorSk` |
| `TRADE_DAILY_MTM_SERIES` | Lazy-populated daily MTM curve per trade (E11.5) | PK `owner`; SK `tradeDateSk` |

All tables: PAY_PER_REQUEST, deletion-protected, no TTL (rows are removed by cascade, never by clock).

## Documentation

| Document | Audience | Description |
|---|---|---|
| [Intent](doc/intent/trade-yield-persistence.intent.md) | AI agents | Why this package owns persistence; context model; cascade contract |
| [Guide](doc/guide/trade-yield-persistence.guide.md) | Maintainers | Schema layout, key encoders, projection helpers, adding a context |
| [Usage](doc/usage/trade-yield-persistence.usage.md) | Consumers | `TradeYieldPersistenceTrustedApi` method reference + examples |
| [Daily MTM Series](doc/usage/trade-daily-mtm-series.usage.md) | Consumers | `_TradeDailyMTMSeries` read/write contract used by the FE chart |

## Core Concepts

- **Three contexts, one set of fact tables.** Segments + sub-trade units carry a `context: YieldContext` discriminator (`'open' | 'asOf:<date>' | 'since:<epoch>'`). The same trade can have parallel segment sets under each. Encoded into the SK so prefix scans serve both "everything in one context" and "everything for one trade (across contexts)".
- **Trusted, not endpoint.** Every method assumes a synthetic session owner is present on the `ExecutionContext` — callers are server-side orchestrators / workers, never REST handlers operating on caller-trusted input.
- **Cascade-delete is package-owned.** `deleteByTrade(tradeUuid)` sweeps every row across all six tables. Orchestrator-side trade/account/import deletion paths call this single method.
- **Projections are explicit.** `_TradeYieldSegment` etc. are persisted shapes; `toTradeYieldSegment(row)` / `toTradeYieldSegmentSummary(row)` produce wire-public shapes that strip `owner`, denormalized keys, and audit fields.
- **Same-day batching invariant** (see `@franzzemen/yield`): two transactions on the same `tradingDate` are persisted as one segment boundary, not two — the upstream walker decides; this package only stores.

## Cross-references

- `~/dev/brokenstock-orchestrator/doc/prd/yield-segment-redesign.prd.md` — full design + E8 epic.
- `@franzzemen/yield` `decomposeTradeGains` + `evaluateTradeYieldSegments` + `aggregateTradeYieldSummary` — the compute side.
- `@franzzemen/financial-identity` — public types (`TradeYieldSegment`, `SubTradeYieldUnit`, `TradeYieldSegmentSummary`, `Archetype`, `SegmentBoundaryKind`).
