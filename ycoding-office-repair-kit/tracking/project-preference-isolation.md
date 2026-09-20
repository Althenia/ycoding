# Project preference test isolation

## Verified defect and repair

`OfficeMain.select_folder` calls `ProjectLedger.save()` without a path. Unlike
`OfficeViewState`, the ledger had no instance persistence path, so folder/boot
tests wrote the real `user://projects.cfg` even when view state was redirected.

`ProjectLedger.file_path` now owns both load and save destinations. The production
default is unchanged. The corrupt-file test's explicit path is assigned to its
instance; folder/boot fixtures redirect both preference stores. The tests assert
real project preference existence and digest remain unchanged across their flow.

No real preference was deleted or rewritten by this repair. Earlier runs were
reported to have written synthetic project entries; the prior user file contents
were not captured by this review, so historical absence of data loss is unproven.

## Validation

Run from the office worktree under `tools/godot_lock.sh`, using Godot 4.7.2,
2048 MB cap, and `--headless --path apps/office --script` with the kit's absolute
`tools/r5_single_suite.gd` path and `-- res://tests/suites/<suite>.gd`:

- `test_project_persistence`: RED 0 passed / 1 failed on the missing instance path;
  GREEN 10 passed / 0 failed. Real temporary files prove independent readback and
  unchanged default preference, not mocked persistence.
- `test_production_boot`: 107 passed / 0 failed, including preference digest checks.
- `test_folder_target`: 40 passed / 0 failed. Its first run leaked two detached
  effort controls; explicit fixture attachment before synchronous disposal removed
  the leaks. The repeated run emitted no engine errors or leak warnings.
- `test_project_ledger`: 45 passed / 0 failed, with an expected ConfigFile parse
  diagnostic from its deliberately malformed file. A strict all-error scan rejects
  that run; it is not described as an error-free run.

`ycoding-office-repair-kit/tools/godot_lock.sh apps/office/tools/verify.sh` returned
exit 0: import/tests/flow passed its script/parse/compile scan, 9477 assertions and
34 flow checks, zero failed assertions. A separate broader scan found resource leaks
in the aggregate suite and flow: 1014 ObjectDB instances and 841 CanvasItems in tests,
two ObjectDB instances in flow, plus the intentional malformed-config diagnostic.
Therefore the full run is NOT a clean resource-lifecycle acceptance result. These
leaks require isolation under R8; their cause was not attributed by this repair.

The editor import generated `test_project_persistence.gd.uid`. `git diff --check`
passed. No visual behavior or stored-data migration was introduced by this repair.
