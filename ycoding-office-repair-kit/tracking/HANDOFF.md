# Current local continuation point

Updated 2026-09-20. Continue in the user-approved office worktree, not the primary
checkout. Preserve the uncommitted repair edits. Do not stage, commit or publish.

## Where you are

The ledger marks **45 of 84 tasks done**. R3-01, R3-02, R4-03, R7-03 and R7-09 are in progress;
R7-04 through R7-08 are dependency-blocked; 29 remain not started. This is task accounting, not current native
or release acceptance. Revalidate affected historical evidence after edits.

| Milestone | State | Notes |
| --- | --- | --- |
| R0 audit | 8/8 done | Independent local audit with native evidence |
| R1 runtime | 7/7 done | Boot, field mapping, retries, streamed text, real provider turn, export exclusion |
| R2 shell | 7/7 done | Docked sidebar, scale ownership, composer, routes, drawer, controls, responsive review (user approved) |
| R9 delivery | 6/8 done | R9-07 needs Linux/Windows hosts + a Rosetta leg; R9-08 needs real signing secrets |
| R3 settings | 0/12 | R3-01 functional checks available, fidelity still open; R3-02 supporting API scope approved, implementation underway. |
| R4 office | 2/8 | Ambient movement fix tested; question/report semantics and walking/native fidelity remain open. |
| R5 projects | 7/7 marked done | Preserve existing folder/project work. |
| R6 conversations | 6/6 marked done | Preserve existing transcript and inspection work. |
| R7 analytics | 2/9 | R7-03 charts are missing despite its old done status. R7-04–08 retain their evidence but await that prerequisite; R7-09 admission/native acceptance remains open. |
| R8 reliability | 0/6 | Final reliability and acceptance checks remain open. |
| R10 release | 0/6 | Release workflow/readiness work remains open; do not publish. |

## R2-07 closed on the user's approval

The user reviewed the responsive artifacts and approved, which supplied the `user_review`
evidence kind an agent could not. The task is recorded as approved by the USER, with no
specific visual findings attributed to them beyond that.

## Current verification and continuation

- `r7-09-reconnect-entrypoint.md` records the actual `start_live` regression check:
  105 passed, 0 failed, without engine errors or leaks at that tested source state.
- `r7-09-harness-review.md` records 18 passing Python harness tests after six RED
  assertion/subtest failures. Godot is mocked in these tests. Resolve source-lock
  and child-process timeout containment before running the real mutation sweep.
- `r4-03-resumed-audit.md` records the ambient guard fix and remaining semantic gaps.
- Visual reference artifacts are `visual-fidelity-20260920.md` and `.toon`.
  Structural validation passed (11 screens, 152 components); this is not native
  visual acceptance. Historical captures must not be presented as the live UI.
- Apply high fidelity to both the application controls and Gather-style pixel office.
  OpenUsage is an additional usage/quota reference, not a new service dependency.
- Hide unsupported usage/quota rows and empty provider sections. Preserve distinct
  loading, stale and error states for supported metrics; never turn absent values into zero.
- `r7-hide-unsupported.md` records the implemented filter: 85 quota checks, 9 failures
  when the filter is disabled, passing neighboring suites, and two inspected native
  synthetic panel captures. It also records the R7 closure-accounting correction.
- `project-preference-isolation.md` records instance-owned project persistence and
  unchanged real-preference checks. Aggregate tests still emit resource leaks beyond
  the narrow error scan in `verify.sh`; do not report those runs as error-free.

## Existing inventories

- **R3-01** settings navigation/search/scope. Its required input now exists: the delivered
  `tracking/tui_parity.json` was a STUB with zero rows, and it has been built from the
  TUI's own settings dialog into **28 capabilities across 7 categories**, each keeping the
  source's own `category`, `path`, `default` and legal `values`. `desktop_equivalent`,
  `gap` and `decision` are deliberately null until a row is actually audited.
- R4-02, R5-01 and R6-01 are marked done in the current ledger; the older continuation
  note's pending labels were stale.

## Blocked, do not guess

- **R3-02 authority gate resolved:** the user explicitly approved the supporting API
  extension and client regeneration on 2026-09-20. Preserve existing contracts and
  stored configuration. Do not test writes against real user configuration.
- **R9-07**: Linux x64 and Windows x64 launch candidates cannot be produced here, and the
  x86_64 macOS slice cannot be exercised (no Rosetta installed).
- **R9-08**: needs a Developer ID certificate and notarization/Authenticode secrets that do
  not exist in this environment.
