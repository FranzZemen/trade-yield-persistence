# Intent: trade-yield-persistence

## Purpose

Single owner of the derived per-trade yield layer in Aurora Postgres. A pure
kysely store: it persists the trade-yield-segment model — segments, sub-trade
yield units, the three summary contexts (open / as-of / since), and the daily
MTM series. It consolidates three legacy packages (`as-of-yields`,
`since-yields`, `yield-snapshots`) that each owned their own table set and
cascade logic; consolidation eliminates the cross-package partial-delete and
schema-drift bugs the prior split caused.

The DDL itself lives in `@franzzemen/brokenstock-postgres-ddl` (migration
`2026-06-08T120000Z_era_4_4a_yield_persistence`); this package consumes the
generated `Database` kysely types and constructs
`TradeYieldPersistenceTrustedApi(ec, db: Kysely<Database>)`.

## Owns

- **Trusted I/O** — `TradeYieldPersistenceTrustedApi` (`api/trade-yield-persistence.trusted.api.ts`), a kysely store over eight tables.
- **Row records + projection helpers** — the `_<row>.ts` identity files and their `rowToRecord` / `to<PublicType>` functions that map between Postgres rows and the public wire shapes.
- **The context model** — `identity/yield-context.ts` (`YieldContext` discriminator, `OPEN_CONTEXT`, `asOfContext`, `sinceContext`). The context is now a real `TEXT` column, not a key prefix.
- **Cascade orchestration** — `deleteByTrade(tradeUuid)` is the only cross-table sweep INSIDE this package; consumers MUST NOT delete table-by-table. The call returns `{deleted: number, asOfDatesTouched: Datestamp[]}` so callers can chain the sibling AS_OF_*_GAINS cascade in `@franzzemen/gain-snapshots` (`GainSnapshotsTrustedApi.deleteAsOfRowsForDates(asOfDatesTouched)`). The chain lives in the orchestrator layer rather than inside this package to keep `trade-yield-persistence` free of a gain-snapshots dependency edge. The canonical cascade contract across trade-delete, import-unprocess, and account-delete (which fans out `deleteByTrade` per `deletedTradeUuids`) is owned by `brokenstock-orchestrator/doc/prd/cascade-delete-coverage-closure.prd.md` and its matrix at `brokenstock-orchestrator/doc/intent/cascade-delete.md`.

## Does not own

- **The DDL / schema.** Tables, indexes, and constraints live in `@franzzemen/brokenstock-postgres-ddl`. This package consumes the generated `Database` interface; it never issues DDL and has no schema files of its own.
- **Yield math.** That lives in `@franzzemen/yield` (`decomposeTradeGains`, `evaluateTradeYieldSegments`, `aggregateTradeYieldSummary`).
- **Public types.** Wire shapes (`TradeYieldSegment`, `TradeYieldSegmentSummary`, `Archetype`, `SegmentBoundaryKind`, `SubTradeYieldUnit`) live in `@franzzemen/financial-identity`; this package only persists them.
- **REST surface.** The in-VPC `app` worker's trade routes (behind the API Gateway → VPC Link → internal ALB edge) call this package through `@franzzemen/brokenstock-orchestrator`.
- **Vendor pricing.** All vendor calls go through `@franzzemen/financial-data` from the in-VPC workers.

## Design invariants

1. **Context discriminator is mandatory on every fact row.** A `_TradeYieldSegment` or `_SubTradeYieldUnit` without `context` is malformed. Context is a real `TEXT` column (`'open'` / `'asOf:<date>'` / `'since:<epoch>'`, CHECK-constrained); every fact read is `WHERE (owner, trade_id, context)`.
2. **The three summaries are three separate tables**, not one keyed table. `open_trade_yield_summaries` is one row per `(owner, trade_id)`; `as_of_trade_yield_summaries` is keyed `(owner, trade_id, as_of_date)` and carries an `(owner, as_of_date)` index for the as-of gain-rollup read the others don't need; `since_trade_yield_summaries` is keyed `(owner, trade_id, since_anchor_epoch)`. Summaries store an aggregated `TradeYieldSegmentSummary` directly; aggregation is computed upstream — this package never aggregates.
3. **Everything is typed columns; ZERO jsonb.** This is the relational migration discipline. The unbounded `transactionPortions[]` on a segment is its own child table (`trade_yield_segment_transaction_portions`, FK'd to `transactions`). The bounded `segmentArchetypeContributions[]` on a daily-MTM row is its own child table (`trade_daily_mtm_archetype_contributions`). Bounded UUID arrays (`sub_trade_uuids` and the managed-rolls lineage uuids) are `TEXT[]`. The `boundaryQuantityDelta {prior, current}` object is two NUMERIC columns. The segment row carries the managed-rolls-segment-unification lineage/DAG fields as columns: `leaf_chain_uuids`, `prior_segment_uuids`, `closing_transaction_uuids`, `opening_transaction_uuids`, `family_cluster_id`, `boundary_qty_delta_prior`, `boundary_qty_delta_current`.
4. **Cascade is FK `ON DELETE CASCADE` to `trades(trade_id)`.** Deleting a trade row auto-sweeps all its yield rows (segments, units, all three summaries, daily-MTM) and the child tables (portions, archetype contributions). The explicit `deleteByTrade` / `deleteFactRowsByTradeAndContext` / `deleteOpenTradeRowsByTrade` / etc. methods remain for *invalidation* — the domain calls them to clear derived rows without deleting the trade — and still return their counts (`deleteByTrade` still returns `asOfDatesTouched` for the gain-snapshots cascade chain).
5. **No TTL anywhere.** Closed trades stay forever; rows leave only via cascade or explicit invalidation.
6. **Daily MTM is lazy and emergent.** `trade_daily_mtm_series` has no "watchlist" sibling table — the watchlist is `getDistinctTradeUuidsWithDailyMTM()`. Row existence drives nightly tail-extension.
7. **Idempotent writes.** Every `put*` is an upsert (`ON CONFLICT … DO UPDATE`); populators rely on this for retry tolerance.
8. **NUMERIC/BIGINT read back as `string`.** Postgres returns NUMERIC and BIGINT as strings over the wire; the `rowToRecord` helpers apply `Number()` at the boundary. DATE columns are projected via `::text` so they hydrate as `'YYYY-MM-DD'` strings.

## Agent guidance

- New context types (e.g., `'projected:<scenario>'`) extend the `YieldContext` discriminator in `identity/yield-context.ts` and need a corresponding query helper, but no DDL change — the same fact tables hold all contexts (it's just a new `context` value).
- A new derived summary shape (e.g., per-account roll-up) belongs in **its own package**, not here — this package is trade-scope only by design.
- "Why is this row stuck after a trade delete?" → the FK cascade handles trade-row deletion; for invalidation flows check `deleteByTrade`'s coverage in `trade-yield-persistence.trusted.api.ts`. Do not add a one-off delete in the caller.

## Provenance (since v1.0.0)

Every fact and summary row carries optional `Provenance` columns (`started_by`,
`job_id`, `writer`, `writer_version`, `written_at`) per the
`persistence-row-provenance.prd.md` D1 contract. Every `put*` that writes a
provenance-bearing table takes a required `provenance: Provenance` parameter and
stamps the five columns onto each row. (`trade_daily_mtm_series` has no
provenance columns in the 4a DDL; `putDailyMTMRows` accepts the parameter for
parity but does not persist it.)

The `OrphanTradeError` write-time guard (from the orphan-summary investigation
2026-05-18) sits ALONGSIDE provenance on `putOpenTradeSummary` /
`putAsOfTradeSummary` — `opts.existsCheck` runs before any write and throws
`OrphanTradeError` (a distinct, catchable class) if the underlying trade no
longer exists, so a race-with-cascade-delete is a benign skip rather than a
chunk failure. See [[feedback_yield_persistence_orphan_guards]].

Admin query helpers (E10, v1.0.0):
- `findStaleOpenTradeSummaries(cutoffEpoch)` — staleness audit.
- `groupOpenSummariesByProvenance(groupBy)` — aggregate by writerLambda /
  startedBy / writerVersion. Surfaces "which writer produced these rows?" in
  one read+groupBy instead of an investigation.

## Cross-references

- `~/dev/brokenstock-postgres-ddl/src/project/migrations/2026-06-08T120000Z_era_4_4a_yield_persistence.ts` — the DDL (source of truth for the eight tables).
- `~/dev/brokenstock-orchestrator/doc/prd/yield-segment-redesign.prd.md` E8 — the package's origin epic; E11.5 — the daily-MTM series addition.
- `~/dev/brokenstock-orchestrator/doc/prd/persistence-row-provenance.prd.md` — the v1.0.0 major-bump that introduced the provenance contract + required `Provenance` arg on every put method.
- `feedback_brokerage_file_imports_gsi_drift` — the cascade-drift pattern this consolidation prevents.
</content>
</invoke>
