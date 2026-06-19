---
doc_type: prd
doc_version: 1.0.0
status: Not Started
supersedes: null
created: 2026-06-19
author: Franz Zemen
primary_repo: trade-yield-persistence
affected_repos:
  - trade-yield-persistence       # persist + rehydrate lineage_graph (root-cause repo)
  - brokenstock-postgres-ddl      # add lineage_graph jsonb column; amend ZERO-jsonb commentary
  - brokenstock-app-worker        # honor ?force=true on /aggregate (recompute live + persist)
  - brokenstock-orchestrator      # pick up new persistence lib (dep bump); recompute path persists lineage
---

# Restore Managed-Roll Lineage Persistence

## Summary

The trade-detail **Managed Rolls** tab is blank for every trade — including heavy
option rollers — showing *"No option managed-roll lineage in this trade."* The lineage
is computed correctly; it is **silently discarded at the persistence boundary** during
the Lambda/DDB → EC2/Aurora migration. The PG `open_trade_yield_summaries` row has no
home for `summary.lineageGraph`, so `putOpenTradeSummary` drops it on write and
`getOpenTradeSummary` cannot rehydrate it. Because the FE reads the **stored** summary
by default (`getStoredTradeYield ?? tradeYields`), and ~1,797 summaries are persisted,
the live-compute path that *would* carry lineage is never hit.

This PRD restores lineage end-to-end:
1. Persist & rehydrate `summary.lineageGraph` via a new `lineage_graph` **jsonb** column
   on `open_trade_yield_summaries` (the sole table the FE managed-rolls tab reads; holds
   both open and closed trades).
2. Honor `?force=true` on the `/aggregate` route so the **Refresh** button recomputes
   live **and** self-heals the stored row.
3. Backfill the existing option-bearing summaries so lineage appears without waiting for
   the nightly rollup.

## Root cause (verified against prod_blue, 2026-06-19)

- Live compute stamps lineage: `brokenstock-orchestrator/.../trade-yields-orchestrator.api.ts:388`
  (`if (lineageGraph) summary.lineageGraph = lineageGraph`).
- **Write drops it:** `trade-yield-persistence/.../trade-yield-persistence.trusted.api.ts:344-411`
  — `putOpenTradeSummary` writes only scalar columns + segment/unit fact rows.
- **No column:** `brokenstock-postgres-ddl/.../schema-types/index.ts` `OpenTradeYieldSummariesTable`
  has no `lineage_graph`.
- **Read can't rehydrate it:** `trade-yield-persistence/.../trade-yield-persistence.trusted.api.ts:430-444`.
- **Stored wins on read:** `brokenstock-app-worker/.../routes/yields/index.ts:120-146`
  (`loadSummary = getStoredTradeYield ?? tradeYields`).
- **Refresh is a no-op:** the `/aggregate` handler ignores `?force=true` (never reads
  `request.query.force`) — `routes/yields/index.ts:137-146`.
- **FE empty-state:** `broken-stock/.../trade-detail/trade-detail.ts:100-114`
  (`summary.lineageGraph ? 'ready' : 'insufficient'`).

Evidence: the APLD **Open** trade `d9235218-6f9f-442d-9650-448553a02784.trade` has **72
option transactions** and `has_stored_summary = true`. prod_blue holds 1,830 trades
(avg 8.3 tx, max 597); **371 (20%) have options** (avg 22.9 tx, max 305 legs). dev_franz
is empty — the deployed FE reads prod_blue.

This is a **migration regression**, not the recent `sealed`/Archive removal — lineage
classification keys off `transaction.action` / `underlyingSymbol` only, and transaction
fetching was never `sealed`-filtered.

## Key decisions (interview-locked)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Which tables get lineage storage | **`open_trade_yield_summaries` only** | Sole table the FE managed-rolls tab reads; holds open + closed trades. `as_of`/`since` have **no** lineage consumer and would multiply large blobs per as-of date. |
| D2 | Storage shape | **jsonb** (whole `TradeLineageGraph`), no hoisted columns | Best I/O profile: rides the summary row already SELECTed → **zero added read queries** on the hot path; write cost is persisting inference output `#coreTradeYields` already computes and currently discards. Relational = worse read I/O (joins) + write amplification for queryability **nothing uses**. Approved exception to the ZERO-jsonb rule: a **bounded, render-only payload** no SQL queries inside. |
| D3 | Future queryability | **Hoist nothing now (YAGNI)** | Every plausible query target (`underlying`, `optionType`, `rollCount`, `termination.kind`, per-event facts) is derivable from `transactions` (source of truth) or already in summary scalars. The inference-only fields (`seriesId`, `pairingRule`, `ambiguous`, split/merge topology) are algorithm-versioned (managed-rolls v1→v3) — exactly what you don't freeze into queryable columns. If a need proves out, hoist that one field to a typed scalar column later (additive, no relationalizing the DAG). |
| D4 | `?force=true` semantics | **Recompute live + persist + return** | Refresh fixes the view *and* heals the stored row so later default loads carry lineage too. Reuses `recomputeAndPersistOpenTrade`. |
| D5 | Backfill | **One-off recompute+persist script**, option-bearing trades only (~371), run on prod_blue | Skips equity-only trades (no lineage) to save compute. Direct + bounded; converges faster than queue fan-out. |
| D6 | Batch/list read | **Project `lineage_graph` OUT** of the batch path | The list/`getStoredBatchTradeYields` path must not detoast lineage for every trade; only the single-trade `/aggregate` read hydrates it. |
| D7 | Regression guard | **put→get round-trip test** | Asserts `lineageGraph` survives persist→rehydrate so it can never silently drop again. |

### jsonb payload (for the queryability record — D3)
`TradeLineageGraph` = `{ asOfEpoch, totalOptionTransactions, discardedSingletonLeaves,
leaves[], lineageGraphs[] }`. `leaves[]` are linear roll chains (`seriesId`, `underlying`,
`optionType`, `direction`, `rollCount`, `termination`, `contributingShares[]`,
`events[]` with per-node strikes/expiries/tx-uuid arrays + `yield`). `lineageGraphs[]`
are split/merge family topology (`segments`/`splits`/`merges`/`transitions`, incl. a
`Record<string,event>` map inside merges that does not map cleanly to rows). Full
inventory in the interview transcript; all of it is the **rendered inference output**,
not source of truth.

## jsonb write/read idiom (follow existing convention)

Per `brokenstock-alerts/.../alerts.trusted.api.ts:193-199`: jsonb columns are written via
`JSON.stringify(value)` (text→jsonb cast); the pg driver returns the **parsed** object on
read. Apply the same:
- Write: `lineage_graph: summary.lineageGraph != null ? JSON.stringify(summary.lineageGraph) : null as any`
- Read: `row.lineage_graph as TradeLineageGraph | undefined` (already parsed).

## Epics

| Epic | Title | Status |
|------|-------|--------|
| E1 | DDL: add `lineage_graph jsonb` + amend ZERO-jsonb commentary | Not Started |
| E2 | Persistence: persist + rehydrate `lineageGraph` (single-read hydrates, batch projects out) | Not Started |
| E3 | Tests: put→get round-trip guard + batch-excludes-lineage | Not Started |
| E4 | app-worker: honor `?force=true` on `/aggregate` (recompute live + persist) | Not Started |
| E5 | Backfill: recompute+persist option-bearing open summaries (prod_blue) | Not Started |
| E6 | Publish + deploy chain (DDL migrate + lib publish + worker deploys, both DBs) | Not Started |
| E7 | End-to-end verification (APLD lineage renders; round-trip confirmed) | Not Started |
| E8 | Update repo docs + global PRD index | Not Started |

---

### E1 — DDL: add `lineage_graph jsonb` + amend ZERO-jsonb commentary
**Repo:** `brokenstock-postgres-ddl`
- New migration `…_era_5_open_summary_lineage_graph.ts`:
  - `up`: `pgm.addColumn('open_trade_yield_summaries', { lineage_graph: { type: 'jsonb', notNull: false } })`.
  - `down`: `pgm.dropColumn('open_trade_yield_summaries', 'lineage_graph', { ifExists: true })`.
  - Additive + nullable → backward compatible; old code ignores the column, so deploy
    order is not load-bearing (but follow the chain in E6 anyway).
- `schema-types/index.ts` → `OpenTradeYieldSummariesTable`: add `lineage_graph: unknown | null; // JSONB TradeLineageGraph (render-only)`.
- **Amend the ZERO-jsonb commentary** in `migrations/2026-06-08T120000Z_era_4_4a_yield_persistence.ts`
  (and `4b_gain_snapshots.ts` if it asserts a blanket rule): document the **approved
  exception** — render-only, bounded, no-SQL-queries-inside payloads (lineage_graph) may
  use jsonb; query/aggregate facts (gains, portions) remain relational.

### E2 — Persistence: persist + rehydrate `lineageGraph`
**Repo:** `trade-yield-persistence`
- `identity/_open-trade-yield-summary.ts`: add `lineageGraph?: TradeLineageGraph` to
  `_OpenTradeYieldSummary`; map it in `toOpenTradeYieldSummary(...)`.
- `api/trade-yield-persistence.trusted.api.ts`:
  - `putOpenTradeSummary` (line ~344): write `lineage_graph` via the `JSON.stringify`
    idiom in both the `values({...})` and the `onConflict … doUpdateSet` branches
    (`lineage_graph: eb.ref('excluded.lineage_graph')`).
  - `getOpenTradeSummary` (line ~430) + `#openSummaryRowToRecord` (line ~1142): hydrate
    `lineageGraph` from the row. Add an **`includeLineage`** option (default **false**):
    - `getStoredTradeYield` (single-trade `/aggregate` read) → `includeLineage: true`.
    - `getStoredBatchTradeYields` (list path) → `includeLineage: false` (**D6** — project
      the column out / skip hydration so the list never detoasts lineage).
  - Confirm `getAllOpenTradeSummaryRows` (admin/staleness) does **not** pull lineage
    (keep its scalar projection lean).
- Note: `TradeYieldSegmentSummary.lineageGraph` wire type already exists
  (`financial-identity/.../trade-yield-segment-summary.ts:101,134`) — no wire change.

### E3 — Tests
**Repo:** `trade-yield-persistence`
- **Round-trip guard (D7):** build a summary with a non-trivial `lineageGraph`,
  `putOpenTradeSummary` → `getOpenTradeSummary`, assert the graph survives byte-for-byte
  (deep-equal). This is the regression canary for the silent-drop class of bug.
- **Batch excludes lineage (D6):** assert `getStoredBatchTradeYields` returns summaries
  without `lineageGraph` (or that the column is not selected on that path).
- Run green via `npx bs.test` before publish (per the never-skip-tests gate).

### E4 — app-worker: honor `?force=true` on `/aggregate`
**Repo:** `brokenstock-app-worker` (`routes/yields/index.ts`)
- Read `request.query.force` on `GET /yields/trade/:tradeUuid/aggregate`. When truthy:
  recompute live **and** persist via
  `TradeYieldsOrchestratorApi.recomputeAndPersistOpenTrade({ tradeUuid, priceSource: 'realtime',
  isClosed: false, startedBy: <session owner|'fe-refresh'> })`, return the fresh summary
  (carries `lineageGraph`). (`isClosed` is presently cosmetic — `#coreTradeYields` treats
  it as `_isClosed`; pass `false`.)
- Default (no force): unchanged `getStoredTradeYield ?? tradeYields` — now returns stored
  lineage because E2 persists it.
- Update the route doc-comment header (lines ~11-12) to note force = live recompute + persist.

### E5 — Backfill (prod_blue)
**Repo:** `trade-yield-persistence` (or `aws-app` scratch, matching the `*.mjs` pattern)
- Script (mirrors `scratch-query.mjs` / `cleanup-*.mjs`): enumerate open-trade summaries
  whose trade has option transactions (~371), and for each call
  `recomputeAndPersistOpenTrade({ priceSource: 'realtime', … })` (bounded concurrency).
  Skip equity-only trades (no lineage to gain).
- Run against **prod_blue** after E6 deploy (dev_franz is empty — skip). Log dropped/skipped
  counts (no silent truncation).

### E6 — Publish + deploy chain
**Repos:** all. Tests green first (E3). Migration-period publish/deploy is pre-authorized;
announce each step. See `reference_worker_deploy_tunnel_migrate_playbook`.
1. **DDL:** bump `brokenstock-postgres-ddl`, `bs.build` → `abs.ddl-publish nonprod` →
   `abs.migrate nonprod dev_franz <ver>` + `abs.migrate nonprod prod_blue <ver>`.
   (Workers also self-apply pending DDL on startup — verify via `information_schema`.)
2. **Library:** `npx bs.publish` `trade-yield-persistence`.
3. **Orchestrator:** bump the persistence dep in `brokenstock-orchestrator`, build (it is
   what the workers bundle for the recompute/persist + force path).
4. **Workers:** redeploy every role that **writes** open-trade summaries so future writes
   persist lineage — at minimum `app-worker` (force + read) and `yields-worker`
   (`yield.recompute-trade` consumer + nightly rollup host). Per role per db:
   `bs.server-build` → `abs.publish nonprod` → `abs.deploy nonprod <role> dev_franz <ver>`
   + `… prod_blue <ver>`.

### E7 — End-to-end verification
- Confirm `lineage_graph` column exists on both DBs (`information_schema.columns`).
- Hit `/yields/trade/d9235218-6f9f-442d-9650-448553a02784.trade/aggregate` (APLD open):
  assert `lineageGraph` is present with non-empty `leaves`/`lineageGraphs`.
- FE: APLD **Managed Rolls** tab renders the roll tree (no empty-state). Spot-check a
  second known roller and an equity-only trade (should still correctly show empty).
- Confirm Refresh (`?force=true`) recomputes + persists (subsequent default load carries
  lineage).

### E8 — Repo docs + global index
- `trade-yield-persistence`: README/usage — document `lineage_graph` persistence, the
  `includeLineage` read flag, and the jsonb exception rationale.
- `brokenstock-postgres-ddl`: schema notes — `open_trade_yield_summaries.lineage_graph`
  (jsonb, render-only) + the documented ZERO-jsonb carve-out.
- `brokenstock-app-worker`: route docs — `?force=true` behavior.
- Add this PRD to `~/dev/projects/PRD-INDEX.md` (Trades & Positions / Yields theme;
  bump `total_count`).

## Out of scope
- `as_of` / `since` lineage persistence (no consumer; **D1**).
- Relational decomposition of lineage (**D2**).
- Field hoisting to scalar columns (**D3** — additive later if a query need proves out).
- Live-open MTM on lineage nodes (`includeMarkToMarket` stays false; realized-only —
  unchanged from current behavior).
