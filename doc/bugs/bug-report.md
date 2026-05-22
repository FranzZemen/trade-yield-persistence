# Bug Report Tracker

This file is a lightweight tracker of bugs reported against this repo.

**It is not maintained beyond the moment a bug is being worked on.** Rows are
added when a bug is reported and updated when it is resolved. After that,
rows are left alone — they do not get re-synced with the current state of
the code. Old entries may reference files, functions, or behaviors that no
longer exist. For ground truth on any fix, use `git log --grep=BUG-NNN`.

Status values: `open`, `investigating`, `fixed`, `wontfix`, `duplicate`, `not-reproducible`.

Index columns hold dates for readability. Per-bug sections hold full ISO 8601
timestamps (with timezone offset) so resolution efficiency can be computed
later: `time-to-start = fix_started - reported`, `fix duration = fixed - fix_started`,
`total cycle = fixed - reported`.

## Index

| ID | Title | Reported | Fix Started | Resolved | Status | Owner repo |
|----|-------|----------|-------------|----------|--------|------------|
| BUG-001 | OrphanTradeError swallowed by logAndEnhanceError wrapping — recompute fails after import delete | 2026-05-22 | 2026-05-22 | 2026-05-22 | fixed | trade-yield-persistence |

## BUG-001: OrphanTradeError swallowed by logAndEnhanceError wrapping — recompute fails after import delete

**Reported:**    2026-05-22T07:26:45-04:00
**Fix started:** 2026-05-22T07:36:08-04:00
**Fixed:**       2026-05-22T07:37:21-04:00
**Status:** fixed

### Report
User deleted all of an account's imports (Fidelity-X69850755-Trading), which
deletes all of that account's trades. The Portfolio/Account Overall period
cards (WTD/MTD/YTD) then showed *"Recompute reported failure — please try
again."* on every "Try again" click. Symptom surfaced in broken-stock
(`recompute.service.ts:158`); root cause traced to this repo.

CloudWatch (`brokenstock-as-of-yield-trade-chunk`, 2026-05-22 07:15 EDT):

```
OrphanTradeError: Refusing to persist as-of summary — tradeUuid=3320e2f8-…trade does not exist
  at TradeYieldPersistenceTrustedApi.putAsOfTradeSummary (trade-yield-persistence.trusted.api.js:362)
  …propagates → runTradeChunkPhase chunk failed → SQS record failed
```

### Findings
Deleting an account's trades while as-of reconstitution chunk jobs are still
in flight (SQS payloads carry a snapshot of trade UUIDs minted before the
delete) is an *accepted* condition. The mitigation is the orphan guard:
`putAsOfTradeSummary` / `putOpenTradeSummary` take an `existsCheck`, throw
`OrphanTradeError` when the trade is gone, and the orchestrator chunk loop
catches it via `isOrphanTradeError()` as a benign skip
(`brokenstock-orchestrator` `as-of-yield-orchestrator.api.ts:297`).

That guard never fired. `putAsOfTradeSummary` throws `OrphanTradeError`
*inside* its own `try` block (`trade-yield-persistence.trusted.api.ts:436`);
the `catch` then ran it through `logAndEnhanceError`, which — because
`OrphanTradeError` is not an `EnhancedError` — constructs a brand-new
`EnhancedError` wrapper (`.name === 'Error'`, the original only as `.cause`).
`isOrphanTradeError(err)` checks `err.name === 'OrphanTradeError'`, so against
the wrapper it returns `false`. The benign skip was missed, the per-trade
error path then re-hit the same wrapped error on the error-summary write, and
the chunk threw → SQS record failed → as-of per-date status `failed` →
recompute coordinator `failed` → FE "Recompute reported failure". Same class
of bug as the `PauseRetryError`-through-wrappers issue: a control-flow signal
error does not survive `logAndEnhanceError`.

### Fix
Added `if (isOrphanTradeError(err)) throw err;` as the first line of the
`catch` block in both `putAsOfTradeSummary` and `putOpenTradeSummary`
(`trade-yield-persistence.trusted.api.ts`), so the orphan signal passes
through unwrapped — mirroring the `PauseRetryError` pass-through convention.
The orphan trade is now correctly skipped by the orchestrator chunk loop.
Separately fixed an adjacent IAM gap surfaced in the same CloudWatch window:
`AsOfGainRollupLambdaRole` (`sam-brokenstock-batch/template.yaml`) was missing
`ObservabilityWriterPolicy` that its sibling AsOfYield roles carry — it was
dropping `reconstitution.*` events with a `BatchWriteItem` AccessDenied.
