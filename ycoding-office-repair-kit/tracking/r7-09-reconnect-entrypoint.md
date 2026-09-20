# R7-09 reconnect entry-point verification

R7-09 remains open. This check does not prove durable prompt admission or visual acceptance.

## Changed test

`apps/office/tests/suites/test_production_boot.gd::test_a_reconnect_reads_the_canonical_state_again` calls `start_live(REGISTERED_URL)` for the initial attach and reconnect. It checks accepted endpoint configuration, clears staleness with a completed reload, and checks that reaching LIVE after reconnect requests another canonical read. It does not manually reset the one-shot guard. The endpoint is a refused loopback endpoint, not a real provider. LIVE and completed-reload callbacks are driven by the test; a real network reconnect is not exercised.

## Fixture cleanup

The first targeted run executed 105 passing assertions but failed log validation: 27 CanvasItem RIDs, 57 ObjectDB instances, and one resource remained at exit. A verbose diagnostic identified `res://ui/prompt/effort_slider.gd`. The hand-built fixture called the composer's `_ready()` and freed its root before the deferred effort-popover attachment could run. The fixture now completes that attachment after parenting the composer, so freeing the root frees the popover too. Production code is unchanged.

## Executed check

From the office worktree root:

```sh
ycoding-office-repair-kit/tools/godot_lock.sh "$GODOT_BIN" --headless --path apps/office --script "$PWD/ycoding-office-repair-kit/tools/r5_single_suite.gd" -- res://tests/suites/test_production_boot.gd
```

Godot 4.7.2: **105 passed, 0 failed**. Final command exited 0; the log scan found no script, parse, compile, engine error, or leak marker. Evidence: `evidence/orch-logs/r7-09-reconnect-entrypoint-green.log`. Failed initial run and verbose diagnostics remain in `r7-09-reconnect-entrypoint.log` and `r7-09-reconnect-leaks.log` in the same directory.

Full-suite integration, a corrected mutation sweep, durable admission evidence, and current native visual acceptance remain unverified after this test edit.
