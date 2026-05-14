# Guide: trade-yield-persistence

For maintainers extending the schema or adding new methods to `TradeYieldPersistenceTrustedApi`.

## Module layout

```
src/project/
  api/
    trade-yield-persistence.trusted.api.ts   # the single TrustedApi class
  bin/
    create-trade-yield-persistence-schema.mjs # one-shot table creator (per tableset)
  identity/
    yield-context.ts                          # YieldContext discriminator + padEpoch
    _trade-yield-segment.ts                   # _TradeYieldSegment + SK encoders + projection
    _sub-trade-yield-unit.ts                  # _SubTradeYieldUnit + SK encoders + projection
    _open-trade-yield-summary.ts              # _OpenTradeYieldSummary + projection
    _as-of-trade-yield-summary.ts             # _AsOfTradeYieldSummary + projection
    _since-trade-yield-summary.ts             # _SinceTradeYieldSummary + projection
    _trade-daily-mtm-series.ts                # _TradeDailyMTMSeries + tradeDateSk encoder
  schema/
    trade-yield-persistence-schema.ts         # table-name constants + SchemaSequence
  project-index.ts                             # public exports
```

## The context model

`YieldContext` is a tagged string:

```
'open'                          // live open-trade view
'asOf:2026-04-15'               // historical reconstitution for one trading day
'since:1714521600000'           // since-anchor windowed view
```

Every fact row (`_TradeYieldSegment`, `_SubTradeYieldUnit`) carries the context, and both SKs encode it. The summary tables specialize:

- `_OpenTradeYieldSummary` SK = `tradeUuid` (one summary per open trade).
- `_AsOfTradeYieldSummary` SK = `asOfDate#tradeUuid` (base) + `tradeUuid#asOfDate` (LSI).
- `_SinceTradeYieldSummary` SK = `padEpoch(anchor)#tradeUuid` (base) + `tradeUuid#padEpoch(anchor)` (LSI).

`padEpoch(n)` (in `identity/yield-context.ts`) zero-pads to 13 digits — keeps lexicographic = numeric so `BETWEEN` queries work against ms epochs.

## Adding a method to `TradeYieldPersistenceTrustedApi`

1. Decide which table the data lives on; pick the matching SK shape and LSI usage.
2. Use `Dynamo.query` (single-partition) over `Dynamo.scan`. Owner is always the PK.
3. For new write paths, define an idempotent encoder helper next to the identity type (`make<XX>Sk`).
4. Reuse the projection helper (`to<PublicType>`) — never inline projection in the API method.
5. If the new path can be invalidated by trade-uuid rotation, extend `deleteByTrade` to cover it. **All cascade-delete is concentrated there.**

## Adding a new context

1. Extend the `YieldContext` template in `identity/yield-context.ts`.
2. Add producer helpers in the caller (orchestrator-side) — `padEpoch` + encoders are already context-agnostic.
3. Add a read method on the trusted API if needed: `get<XX>RowsForOwnerAndContext(context)`.
4. No schema change required — the fact tables hold any context.

## Adding a new summary shape

If the new summary is **trade-scope**, give it its own table here following the as-of/since pattern (base SK + LSI for cascade). If it's **account- or portfolio-scope**, it does NOT belong in this package — see `@franzzemen/gain-snapshots`.

## Schema migration

`bin/create-trade-yield-persistence-schema.mjs` drives the per-tableset migration:

1. Set `AWSSECRET` + `EXECUTION_CONTEXT_PROFILE` env.
2. Run the bin script — it walks the `SchemaSequence.create` array and creates missing tables idempotently. Existing tables (with their data) are left untouched.

`SchemaSequence.updates` is intentionally empty — schema changes go through delete-and-recreate per dev-mode policy (no live data to migrate yet).

## Adding `_TradeDailyMTMSeries`-style cache tables

E11.5's `_TradeDailyMTMSeries` is the template:

- Base SK only (`tradeDateSk = '${tradeUuid}#${padEpoch(dateEpoch)}'`).
- No LSI — every read is per-trade.
- "Watchlist" emerges from a `Scan` for distinct `tradeUuid` values (`getDistinctTradeUuidsWithDailyMTM`).
- Cascade hooked into `deleteByTrade` via a prefix-scoped `Query` + `batchDelete`.

## Build & publish

Standard `@franzzemen/*` flow:

```
npx bs.build           # compile + copy to out/
npx bs.test            # mocha across src/test
npx bs.publish         # publishes from out/
```

See `~/dev/projects/package.json` `npmuDependencies` for the upstream chain; this package depends on `financial-identity`, `endpoint-financial-identity`, `aws-app/dynamo`, `endpoint-application`, `utility`.

## Cross-references

- Usage (consumer-facing): `doc/usage/trade-yield-persistence.usage.md`.
- Schema source of truth: `src/project/schema/trade-yield-persistence-schema.ts`.
- Cascade contract: `deleteByTrade` in `src/project/api/trade-yield-persistence.trusted.api.ts`.
