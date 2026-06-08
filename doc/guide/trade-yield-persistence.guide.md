# Guide: trade-yield-persistence

For maintainers extending this package or adding new methods to `TradeYieldPersistenceTrustedApi`.

This package is a pure kysely store over Aurora Postgres. The DDL lives in
`@franzzemen/brokenstock-postgres-ddl`; this package consumes its generated
`Database` interface and never issues DDL itself.

## Module layout

```
src/project/
  api/
    trade-yield-persistence.trusted.api.ts   # the single TrustedApi class (kysely)
  identity/
    yield-context.ts                          # YieldContext discriminator + asOf/since/OPEN helpers + padEpoch
    _trade-yield-segment.ts                   # _TradeYieldSegment record + segmentRowToRecord + projection
    _sub-trade-yield-unit.ts                  # _SubTradeYieldUnit record + unitRowToRecord + projection
    _open-trade-yield-summary.ts              # _OpenTradeYieldSummary + projection
    _as-of-trade-yield-summary.ts             # _AsOfTradeYieldSummary + asOfSummaryRowToRecord + projection
    _since-trade-yield-summary.ts             # _SinceTradeYieldSummary + sinceSummaryRowToRecord + projection
    _trade-daily-mtm-series.ts                # _TradeDailyMTMSeries + dailyMtmRowToRecord
  project-index.ts                             # public exports
```

There is no `schema/` or `bin/` directory — those were deleted in the Postgres
migration. The table set, indexes, and constraints are defined by the DDL
migration in `@franzzemen/brokenstock-postgres-ddl`, and the kysely `Database`
type is generated from it.

## The eight tables

The six logical entities are relationalized into eight tables:

| Table | Key | Notes |
|---|---|---|
| `trade_yield_segments` | `segment_id` PK | `(owner, trade_id, context)` index for fact reads |
| `trade_yield_segment_transaction_portions` | `(segment_id, transaction_id)` PK | child of segment; the unbounded `transactionPortions[]`, FK'd to `transactions`; reverse index on `transaction_id` for backdated-tx invalidation |
| `sub_trade_yield_units` | `unit_id` PK | `(owner, trade_id, context)` index |
| `open_trade_yield_summaries` | `(owner, trade_id)` PK | one per open trade |
| `as_of_trade_yield_summaries` | `(owner, trade_id, as_of_date)` PK | `(owner, as_of_date)` index for the as-of gain-rollup read |
| `since_trade_yield_summaries` | `(owner, trade_id, since_anchor_epoch)` PK | |
| `trade_daily_mtm_series` | `(owner, trade_id, date_epoch)` PK | `(owner, trade_id, date)` index for the ordered chart scan |
| `trade_daily_mtm_archetype_contributions` | `(owner, trade_id, date_epoch, archetype)` PK | child of daily-MTM; bounded `segmentArchetypeContributions[]` (≤16 archetypes) |

Every fact-bearing table FKs `trades(trade_id) ON DELETE CASCADE`; the two child
tables FK their parent `ON DELETE CASCADE`.

## The context model

`YieldContext` is a tagged `TEXT` value (`identity/yield-context.ts`):

```
'open'                          // live open-trade view
'asOf:2026-04-15'               // historical reconstitution for one trading day
'since:1714521600000'           // since-anchor windowed view
```

It is a real column on `trade_yield_segments` and `sub_trade_yield_units`, with
a CHECK (`context = 'open' OR context ~ '^asOf:' OR context ~ '^since:'`). Every
fact read is `WHERE (owner, trade_id, context)`. The three summary contexts each
get their own typed columns instead of a context string: open has none, as-of
has `as_of_date DATE` + `as_of_epoch BIGINT`, since has `since_anchor_epoch BIGINT`.

`padEpoch(n)` (still in `yield-context.ts`) and the `asOfContext` / `sinceContext`
builders construct the `context` string for the fact tables. `padEpoch` is no
longer load-bearing for sort order (Postgres orders `since_anchor_epoch`
numerically), but the `since:<epoch>` context string is built from it for
consistency.

## The relational shape (no jsonb)

The migration discipline is zero jsonb. When you add a column or table, keep it:

- **Unbounded array → child table.** `transactionPortions[]` is `trade_yield_segment_transaction_portions` (FK to both the segment and `transactions`).
- **Bounded array → child table or `TEXT[]`.** `segmentArchetypeContributions[]` is its own bounded child table; `sub_trade_uuids` and the lineage uuid arrays (`leaf_chain_uuids`, `prior_segment_uuids`, `closing_transaction_uuids`, `opening_transaction_uuids`) are `TEXT[]`.
- **Small fixed object → one column per field.** `boundaryQuantityDelta {prior, current}` is `boundary_qty_delta_prior` + `boundary_qty_delta_current` (two NUMERIC columns).

Introducing jsonb requires explicit approval — default to relational.

## Reading rows back

Postgres returns NUMERIC and BIGINT as `string`, so the `rowToRecord` helpers
(`segmentRowToRecord`, `unitRowToRecord`, `asOfSummaryRowToRecord`,
`sinceSummaryRowToRecord`, `dailyMtmRowToRecord`, and the inline
`#openSummaryRowToRecord`) apply `Number()` at the boundary. DATE columns
(`as_of_date`, `closing_date`, `date`) are selected via a `sql<string>\`…::text\``
projection so they hydrate as `'YYYY-MM-DD'` strings rather than JS `Date`s.

## Adding a method to `TradeYieldPersistenceTrustedApi`

1. Decide which table the data lives on; owner is always derived via `getSessionOwner(this.ec)` and is the leading WHERE predicate.
2. Build the kysely query off `this.#db` (`selectFrom` / `insertInto` / `deleteFrom`). Project DATE columns with `::text` and `Number()` NUMERIC/BIGINT in the matching `rowToRecord` helper.
3. For writes, prefer an idempotent `ON CONFLICT … DO UPDATE` upsert keyed on the table's PK.
4. Reuse the projection helper (`to<PublicType>`) — never inline projection in the API method.
5. If the new path can be invalidated by trade-uuid rotation or yield-math change, extend `deleteByTrade` to cover it. **All explicit cascade-delete is concentrated there** (the FK cascade covers trade-row deletion automatically).
6. Wrap the body in `try/catch` → `logAndEnhanceError(log, err)`, but pass `OrphanTradeError` through unwrapped (it's a control-flow signal, not an infra error).

## Adding a new context

1. Extend the `YieldContext` template + its CHECK pattern (the CHECK lives in the DDL migration in `brokenstock-postgres-ddl` — coordinate a migration there if the new prefix isn't already allowed).
2. Add producer helpers (a `context` builder) in `identity/yield-context.ts`.
3. Add a read method on the trusted API if needed (`get<XX>RowsForTradeAndContext`).
4. No new table required — the fact tables hold any context value.

## Adding a new summary shape

If the new summary is **trade-scope**, add a table in `brokenstock-postgres-ddl`
following the as-of/since pattern (its own PK + the FK to `trades` with
`ON DELETE CASCADE`), then add the matching record + projection + I/O here. If
it's **account- or portfolio-scope**, it does NOT belong in this package — see
`@franzzemen/gain-snapshots`.

## Schema migration

There is no per-package migration script. DDL changes go through the
`@franzzemen/brokenstock-postgres-ddl` migration pipeline (`abs.ddl-publish` /
`abs.migrate`); after the `Database` type regenerates, refresh this package's
dependency and update the affected `rowToRecord` / I/O code.

## Build & publish

Standard `@franzzemen/*` flow:

```
npx bs.build           # compile + copy to out/
npx bs.test            # mocha across src/test
npx bs.publish         # publishes from out/
```

This package depends on `financial-identity`, `endpoint-financial-identity`,
`endpoint-application`, `utility`, and the generated kysely types from
`@franzzemen/brokenstock-postgres-ddl`. The `Kysely<Database>` instance is
supplied by the caller at construction — this package does not own the connection.

## Cross-references

- Usage (consumer-facing): `doc/usage/trade-yield-persistence.usage.md`.
- DDL source of truth: `~/dev/brokenstock-postgres-ddl/src/project/migrations/2026-06-08T120000Z_era_4_4a_yield_persistence.ts`.
- Cascade contract: `deleteByTrade` in `src/project/api/trade-yield-persistence.trusted.api.ts`.
</content>
