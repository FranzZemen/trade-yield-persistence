# Trade Yield Persistence — UAT

## Overview

Progressive UAT for `@franzzemen/trade-yield-persistence` — the 5 new persistence tables + `_TradeDailyMTMSeries` + trusted-API surface introduced by the yield-segment-redesign PRD (`brokenstock-orchestrator/doc/prd/yield-segment-redesign.prd.md`, E8 + E11.5).

**Scope:** round-trip writes + reads + projector hydration across `_TradeYieldSegment`, `_SubTradeYieldUnit`, `_OpenTradeYieldSummary`, `_AsOfTradeYieldSummary`, `_SinceTradeYieldSummary`, and `_TradeDailyMTMSeries`. Context isolation (open vs as-of vs since on the same trade). Cascade-delete coverage.

**Verification:** tester triggers writes via real UI flows (Segments tab refresh, as-of compute, since-trade-yield fetch). Agent queries DynamoDB directly via `aws dynamodb query` / dynamodb-admin to verify row shape, projector output, and cascade behavior.

**Statuses:** `Not Tested` | `Testing` | `Pass` | `Fail` | `Deferred`

---

## Prerequisites

1. `@franzzemen/trade-yield-persistence@^0.3.x` published with all 6 tables + projectors + `TradeYieldPersistenceTrustedApi` (including `_TradeDailyMTMSeries` API).
2. DDB tables provisioned in both `production` + `test` tablesets:
   - `financials.trade-yield-persistence.trade-yield-segments`
   - `financials.trade-yield-persistence.sub-trade-yield-units`
   - `financials.trade-yield-persistence.open-trade-yield-summaries`
   - `financials.trade-yield-persistence.as-of-trade-yield-summaries`
   - `financials.trade-yield-persistence.since-trade-yield-summaries`
   - `financials.trade-yield-persistence.trade-daily-mtm-series` (with tradeUuid GSI)
3. ExecutionContext config has all 6 table mappings in production + test.
4. Sam handlers + batch lambdas have IAM grants for the 6 tables.
5. Tester has identifiable fixture trades: at least 1 open trade with multiple segments, at least 1 closed trade.

---

## Test Definitions

### TD-1 — `TradeYieldSegmentSummary` Round-Trip

| ID | Test | Steps | Expected Result |
|----|------|-------|-----------------|
| RT-01 | Write + read same summary | Trigger a Segments tab refresh (`force=true`) on a multi-segment trade. The orchestrator calls `putOpenTradeSummary`. Then call `getOpenTradeSummary(tradeUuid)` via the trusted API or REST. | Returned shape matches what was written. Segment count, archetype tags, denominators, gains all bit-identical. `priceCoverage` + `recomputeAttempts` round-trip cleanly. |
| RT-02 | Projector hydration on read | After RT-01, inspect the raw DDB item then call the projector. | Projector produces the same `TradeYieldSegmentSummary` shape as the orchestrator's in-memory value. No fields missing. No nullPointer on optional fields (`recomputeAttempts`, `priceCoverage`, etc.). |
| RT-03 | Write-then-rewrite (recompute) | Refresh the same trade twice in a row with `force=true`. | Second write replaces first cleanly. `computedAt` updates. No duplicate rows. Segments[] array fully replaces (not append). |
| RT-04 | Persisted segment rows | Query `_TradeYieldSegment` table by trade. | One row per segment. Each row's `archetype`, `denominator`, `startEpoch`, `endEpoch` (null for open), `gain`, `transactionPortions[]` populated. |

### TD-2 — Context Isolation (Open / As-Of / Since on Same Trade)

| ID | Test | Steps | Expected Result |
|----|------|-------|-----------------|
| CI-01 | Write open summary → read does not affect as-of | Compute and persist open summary for trade T. Then trigger as-of compute for T on a historical date. | Open summary unchanged. As-of summary lives in its own table (`AS_OF_TRADE_YIELD_SUMMARIES`) keyed by `(tradeUuid, asOfDate)`. No cross-contamination. |
| CI-02 | As-of write does not touch open | Following CI-01, re-read open summary. | Open summary's `computedAt` unchanged. `priceCoverage` unchanged. `recomputeAttempts` unchanged. |
| CI-03 | Since write isolated | Trigger a since-trade-yield fetch for T with a 30-day anchor. | `_SinceTradeYieldSummary` row keyed by `(tradeUuid, anchorEpoch)` written. No effect on open or as-of summaries. |
| CI-04 | Each context has its own segment row write-paths | Confirm `_TradeYieldSegment` rows partition by context scope (or are scoped per-summary row, depending on design). | Per the locked design — segments are persisted per-context; an as-of compute does not overwrite open-context segments. |

### TD-3 — Cascade Delete

| ID | Test | Steps | Expected Result |
|----|------|-------|-----------------|
| CD-01 | Delete trade → all 5 yield tables cleared | Run the trade-delete cascade (via owner-cleanup script or the standard trade-delete REST path) for a test trade. | Zero rows remain in `_TradeYieldSegment`, `_SubTradeYieldUnit`, `_OpenTradeYieldSummary`, `_AsOfTradeYieldSummary`, `_SinceTradeYieldSummary` for that tradeUuid. |
| CD-02 | Daily-MTM cascade | Following CD-01, also verify `_TradeDailyMTMSeries`. | Zero rows remain in `_TradeDailyMTMSeries` for the deleted tradeUuid. |
| CD-03 | Account-level delete cascades through | Delete an account that contained N trades. | All N trades' rows across all 6 yield tables removed. No orphans. |
| CD-04 | Owner-level wipe | Use `~/dev/aws-app/cleanup-owner.mjs` (or equivalent owner-scoped delete). | Zero rows remain across all 6 yield tables for that owner. |

### TD-4 — `_TradeDailyMTMSeries` Query Path

| ID | Test | Steps | Expected Result |
|----|------|-------|-----------------|
| DM-01 | GSI query by tradeUuid returns chronological series | After populator runs, call `getDailyMTMSeries(tradeUuid)` via trusted API. | Returns array sorted by `mtmEpoch` ascending. Each row carries `mtmAmount`, `carAtDate`, `segmentArchetypeContributions[]`, `priceCoverage`. |
| DM-02 | Empty series returns empty array | Call on a trade with no rows. | Returns `[]`, not null, not error. Caller can enqueue populator separately. |
| DM-03 | Idempotent put | Run populator twice on same trade in `full` mode. | Same row count. Last-writer-wins on values. No duplicates. |
| DM-04 | Tail-extend append-only | Run populator in `tail-extend` mode on an active trade with stale series. | Existing rows untouched. New rows appended for the missing-tail dates only. |

---

## Enhancements Discovered

_To be filled in during testing if any non-bug improvements are identified._

- (Potential) Add a single `getAllSummariesForTrade(tradeUuid)` convenience method that returns `{ open, asOfMap, sinceMap, dailyMTM }` so callers don't need 4 separate trips during admin diagnostics.

---

## Test Run History

- **2026-05-14** — first-pass dogfooding via Segments tab + Open Positions on KTOS/CONL/DXYZ. Result: pass with banner-flicker noted under Enhancements (FE polish E11.9 already landed).
