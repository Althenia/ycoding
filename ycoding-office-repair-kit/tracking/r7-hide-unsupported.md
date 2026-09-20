# Unsupported quota presentation

The user's 2026-09-20 instruction hides unsupported usage/quota entries rather
than rendering an Unsupported row or placeholder. Only `status == unsupported`
is filtered; available, stale, unauthorized, error and unknown states remain.
Snapshots remain in the read model. The real StatisticsPanel and its export use
the filtered provider rows. Supported metrics may still use charts or bars.

## Changes and checks

- `core/quota_page.gd`: filters provider rows without mutating delivered snapshots.
- `ui/statistics/statistics_panel.gd`: renders a page-level empty state when no
  visible provider rows remain, with no per-provider unsupported card.
- `tests/suites/test_quota_windows.gd`: verifies the real panel, preserved statuses,
  source data, absent placeholder bars and both empty states. The previously
  unwired empty-state case is registered. A blanket ban on all progress bars was
  narrowed to unsupported-only data, matching the actual user requirement.
- `docs/runtime.md`: documents the display filter and preserved status semantics.

Godot 4.7.2, run from the office worktree under `tools/godot_lock.sh`, 2048 MB cap:

```sh
Godot --headless --path apps/office --script <absolute-kit>/tools/r5_single_suite.gd -- res://tests/suites/test_quota_windows.gd
```

The saved implementation passed 85 assertions. Disabling the actual filter
produced 9 intended failures, including the real panel naming the unsupported
provider (77 passed / 9 failed, exit 1). Restoring the filter returned 85/0.
Neighboring suites passed: statistics 45/0, budgets 53/0, exports 45/0. All four
targeted runs emitted no engine errors or leak warnings.

Native command:

```sh
Godot --path apps/office --script <absolute-kit>/tools/capture_hidden_quota.gd
```

After correcting a type-inference parse error in the capture driver, it returned
exit 0 and verified mixed and unsupported-only states. Parent inspected both PNGs
under `evidence/hide-unsupported/`. They show the real panel with clearly labelled
synthetic data, not a real provider account or full-shell fidelity acceptance.

The final `godot_lock.sh apps/office/tools/verify.sh` returned exit 0 with 9508
assertions and 34 flow checks. Its narrow script-error scan passed; broader logs
retain the aggregate resource leaks and intentional malformed-config diagnostic
recorded in `project-preference-isolation.md`. No clean aggregate lifecycle result
is claimed. No real credentials, provider request or configuration write was used.

## Ledger correction

R7-03 was marked done despite its own notes saying the required daily chart and
activity calendar remained open. The current StatisticsPanel and inspected native
captures confirm those required chart surfaces are absent. Reopen R7-03. R7-04
through R7-08 retain their implementation and evidence but are blocked from closure
by their declared dependency chain. This is corrected accounting, not a rollback of
their working code. R7-09 remains in progress for its independent evidence work.
