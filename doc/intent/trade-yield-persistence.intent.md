# Intent: trade-yield-persistence

## Purpose

Single owner of DynamoDB persistence for the trade-yield-segment model. Replaces three legacy packages (`as-of-yields`, `since-yields`, `yield-snapshots`) that each owned their own table set and cascade logic. Consolidation eliminates the cascade-coordination bugs the prior split caused (cross-package partial deletes, GSI drift between sibling packages).

## Owns

- **Schema definitions** for six tables (`schema/trade-yield-persistence-schema.ts`).
- **Key encoders** for every SK shape (one helper per table; located alongside the `_<row>.ts` identity files).
- **Trusted I/O** — `TradeYieldPersistenceTrustedApi` (`api/trade-yield-persistence.trusted.api.ts`).
- **Projection helpers** — `to<PublicType>(row)` functions that strip persistence-only fields.
- **Cascade orchestration** — `deleteByTrade(tradeUuid)` is the only cross-table sweep INSIDE this package; consumers MUST NOT delete table-by-table. As of 0.4.x the call returns `{deleted: number, asOfDatesTouched: Datestamp[]}` so callers can chain the sibling AS_OF_*_GAINS cascade in `@franzzemen/gain-snapshots` (`GainSnapshotsTrustedApi.deleteAsOfRowsForDates(asOfDatesTouched)`). The chain lives in the orchestrator layer rather than inside this package to keep `trade-yield-persistence` free of a gain-snapshots dependency edge (and its `config.json` free of gain-table mappings).

## Does not own

- **Yield math.** That lives in `@franzzemen/yield` (`decomposeTradeGains`, `evaluateTradeYieldSegments`, `aggregateTradeYieldSummary`).
- **Public types.** Wire shapes (`TradeYieldSegment`, `TradeYieldSegmentSummary`, `Archetype`, `SegmentBoundaryKind`, `SubTradeYieldUnit`) live in `@franzzemen/financial-identity`; this package only persists them.
- **REST surface.** `sam-brokenstock`'s `lambda-trades` handlers call this package through `@franzzemen/brokenstock-orchestrator`.
- **Vendor pricing.** All vendor calls go through `@franzzemen/financial-data` from worker lambdas.

## Design invariants

1. **Context discriminator is mandatory on every fact row.** A `_TradeYieldSegment` or `_SubTradeYieldUnit` without `context` is malformed. Context is encoded into both SKs so prefix scans isolate it.
2. **Summary tables are PSCaR-shaped, not fact-row collections.** Open/as-of/since summaries store aggregated `TradeYieldSegmentSummary` directly (segment UUIDs reference back to the fact tables). Aggregation is computed upstream — this package never aggregates.
3. **No TTL anywhere.** Closed trades stay forever; rows leave only via cascade. (Confirmed 2026-05-13: TTL was originally specified on `_AccountYieldSnapshot` but removed per memory `project_account_snapshot_ttl_removal`; same policy applies here.)
4. **Daily MTM is lazy and emergent.** `_TradeDailyMTMSeries` has no "watchlist" sibling table — the watchlist is `getDistinctTradeUuidsWithDailyMTM()`. Row existence drives nightly tail-extension.
5. **Idempotent writes.** Every `put*` is upsert-safe; populators rely on this for retry tolerance.

## Agent guidance

- New context types (e.g., `'projected:<scenario>'`) extend the `YieldContext` discriminator in `identity/yield-context.ts` and need a corresponding query helper, but no schema change — same fact tables hold all contexts.
- A new derived summary shape (e.g., per-account roll-up) belongs in **its own package**, not here — this package is trade-scope only by design.
- "Why is this row stuck after a trade delete?" → check `deleteByTrade`'s coverage in `trade-yield-persistence.trusted.api.ts`; do not add a one-off delete in the caller.

## Provenance (since v1.0.0)

Every row in every table carries optional `Provenance` fields (`startedBy`,
`jobId`, `writerLambda`, `writerVersion`, `writtenAt`) per the
`persistence-row-provenance.prd.md` D1 contract. Every `put*` method takes a
required `provenance: Provenance` parameter (no optional-first phase per D13);
the internal `#stampRows()` helper spreads the 5 fields onto each row before
batchPut.

The `OrphanTradeError` write-time guard (from the orphan-summary investigation
2026-05-18) sits ALONGSIDE provenance on `putOpenTradeSummary` /
`putAsOfTradeSummary` — `opts.existsCheck` is a separate concern from
provenance; both are first-class. See [[feedback_yield_persistence_orphan_guards]].

Admin query helpers added in E10 (v1.0.0):
- `findStaleOpenTradeSummaries(cutoffEpoch)` — staleness audit.
- `groupOpenSummariesByProvenance(groupBy)` — aggregate by writerLambda /
  startedBy / writerVersion. Surfaces "which writer produced these rows?" in
  one Query+groupBy instead of an investigation.

## Cross-references

- `~/dev/brokenstock-orchestrator/doc/prd/yield-segment-redesign.prd.md` E8 — the package's origin epic.
- `~/dev/brokenstock-orchestrator/doc/prd/yield-segment-redesign.prd.md` E11.5 — `_TradeDailyMTMSeries` addition.
- `~/dev/brokenstock-orchestrator/doc/prd/persistence-row-provenance.prd.md` — the v1.0.0 major-bump that introduced the provenance contract + required `Provenance` arg on every put method.
- `feedback_brokerage_file_imports_gsi_drift` — the cascade-drift pattern this consolidation prevents.
