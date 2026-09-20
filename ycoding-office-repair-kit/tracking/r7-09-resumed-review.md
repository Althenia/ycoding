# R7-09 resumed review (read-only)

Scope: audit the R7-09 fix, its regression tests, the capture driver, and the kit logs against
the acceptance "Record source provenance; estimate vs billed distinction; quota failure cannot
break normal coding". No source, ledger, or service data was changed. Worktree:
`/Users/viadz/Workspace/Project/ycoding.worktrees/office`. Live service pid 48559,
`sourceEpoch e33e3eb5-c681-4616-9527-f692084f3bcd`.

Verdict: **R7-09 must not close yet.** Three reachable defects and two evidence gaps remain.

## 1. Logs are genuine but stale

- `evidence/orch-logs/suite-r7-09b.log` is a real full-runner pass: `passed: 8965 / failed: 0 /
  RESULT: PASSED / EXIT=0`. It is dated 2026-09-18 and predates the current source.
- The current tree runs 9463 assertions (`/tmp/r3-01-nopref.log`, 2026-09-20 08:22:40, 54
  suites). `test_production_boot.gd` changed again at 08:27 (isolation run 107/0). No full-suite
  run exists at the current revision, so 8965/0 is not evidence about the code under audit.
- `verify.sh` reports `engine_errors=0`, but its scan matches only `SCRIPT ERROR|Parse
  Error|Compile Error`; the logs contain `ERROR: ConfigFile parse error` (an asserted test
  fixture), `ERROR: 47 resources still in use` and `ERROR: 41 RID allocations ... leaked`,
  which that gate cannot see. "engine_errors=0" is weaker than it reads.
- `r7-09-capture13.log` is real: 13 checks, 0 fails, EXIT=0, roster=50, reload_ready.

## 2. Defect — the list→session seeding drops `parentID`

`apps/office/integration/live_transport.gd::_begin_session_replays` synthesizes
`session.created` from each list row but copies only `agent, title, location, model, projectID,
subpath`. The live row declares `parentID` (`packages/schema/src/session.ts:37`) and the running
service returns it: of the newest 50 rows, 43 carry a parent. `apply_session_created` reads
`data.get("parentID", "")`, so **every seeded session is stored as a root**, and
`root_session_id` becomes the last row of the batch.

Verified live: the last row is `ses_compaction_…`, a `compaction` child of
`ses_32cf28a6-…`, and it would be adopted as the office root. Consequences for the whole
adopted roster (the feed replays nothing, so no later `session.created` corrects it):
`child_session_ids` is empty for every session, `family_session_ids` collapses to `[self]`,
`report_target_for` returns the wrong session, and `_prompt_target()` /
`refresh_statistics()` fall back to a compaction child when nothing is selected.

The regression fixture teaches the absent shape: `test_the_session_list_publishes_each_sessions_existence`
(`test_live_transport.gd`) supplies rows without `parentID` and asserts only roster presence, so
the omission is invisible to the suite. This is the trap the office wire-field skill names.

## 3. Defect — the analytics mutation harness still counts a timeout as detection

`tools/audit_r7_09_mutations.py` (unchanged since 2026-09-18) computes
`caught = (failed not in ("0","?")) or hung`, has no clean-baseline gate, no engine-error
rejection and no exit-status agreement. Its log records
`a bounded quota read is unbounded … CAUGHT (hung)` — timeout-based detection, which is not
behavioral proof. Only `tools/audit_r7_09_regression.py` was repaired (2026-09-20 08:15) with
the stricter `RunResult` verdicts; the analytics harness was not.

## 4. Gap — the repaired regression harness has never been run as a sweep

No log from `audit_r7_09_regression.py` exists. The only `/tmp/r7_09_reg.log` (08:41,
`SINGLE passed=5 failed=0`) is written by the harness's own Python unit test through its stub
process sink, not by Godot; it must not be read as a sweep result. Discrimination is currently
supported only by the older harness logs (`r7-09-regression2.log`): the two `main.gd` mutations
were caught by real assertion failures (101/2 and 102/1), and the three list-seeding mutations by
46/5, 48/5, 49/4 — behavioral, not timeout-based. `test_r7_09_regression.py` re-run here: 18
tests, OK.

## 5. Gap — the capture proves queuing, not admission, and not the visible label

- The safety clause is asserted by `notice.to_lower().contains("sent")`. The notice is set when
  `submit_prompt` returns `""`, i.e. the POST was issued; it is not a service admission.
  `_session_has_text` exists but is never called, and no admission artifact exists in
  `evidence/`. The driver comment claiming external confirmation is unsupported by the kit.
- Independently verified now against the live service: the three successful runs did reach
  durable admission. `ses_238c8a62-345f-4a30-a16f-f69bb3ffce26` holds user messages
  `r709-quota-failure-probe-4282` (capture10), `-4674` (capture12) and `-4353` (capture13), each
  followed by a real assistant/compaction run. So the behaviour is real; the kit's evidence chain
  is what is missing.
- **The capture mutated a real session.** Those three prompts are durable inputs in a real root
  session (agent `god`) and triggered provider work. The refused runs (capture4/5/8/9) sent
  nothing. This must be recorded, not repeated casually.
- `the surface shows the spend cards with their provenance labels` only asserts
  `shown.contains("Spend")`. It never asserts that the recorded and catalog-estimate labels are
  both rendered. Capture13's data has only `recorded` groups, so the estimate card reads "Not
  reported" and the final capture does not display the distinction at all. Capture4 did exercise
  `estimated` + `recorded` labels (11 checks, exit 0) but at an older driver revision without the
  prompt-target check; captures 2 and 3 aborted (`Abort trap: 6`, EXIT=134).
- `SessionUsage.cost_provenance_text()` reports the first priced group's provenance, so a mixed
  session is labelled by one group. The product panel does not use it (it splits per provenance
  in `StatisticsPage._spend_text`); the capture's provenance check does, so that check is lossy.

## 6. Reconnect coverage — real entry point, no real reconnect

`test_a_reconnect_reads_the_canonical_state_again` calls the real `start_live(REGISTERED_URL)`
for both the initial attach and the reconnect (`REGISTERED_URL = http://127.0.0.1:1`, refused),
then drives `_on_connection_changed(LIVE)` and `adopt_reload` itself. It does not call
`_rearm_canonical_read` directly, so the guard's only production caller is exercised. The
transport-level reconnect path is covered separately by
`test_a_cleanly_closed_feed_stops_claiming_a_live_connection`, which drives the internal
`_handle` with a `KIND_CLOSED` entry. No real socket reconnect or real reload completion occurs in
either test; staleness is the proxy for "the read was asked for". That is acceptable as a
discrimination signal, and the mutation is caught by a real assertion failure.

## 7. Residue

`apps/office/r7_09_capture_tmp.gd` (stale Sep-18 copy of the kit driver) and
`apps/office/r5_single_suite_tmp.gd` (written 08:27 today) are untracked probe copies left in the
app tree; the harness writes them and removes them, but an interrupted sweep leaves them. The
capture driver also sets `scene.capture_mode = true` and never clears it, and quits without
freeing the scene (1 RID + 2 ObjectDB leaks in the log). `godot_lock.sh` serializes Godot
processes only, not source writes, so a sweep still races the settings lane editing `main.gd`.

## Before R7-09 can close

1. Carry `row.get("parentID", "")` in the seeded `session.created`, and add the parentage
   assertion the current fixture omits (child + root in one list, both parented correctly).
2. Run one real sweep of `audit_r7_09_regression.py` at a frozen revision, with no other writer
   on `main.gd`/`live_transport.gd`, and accept only behavioral failures.
3. Repair `audit_r7_09_mutations.py` to the same verdict rules (timeout is UNVERIFIED, not
   CAUGHT) and re-run it.
4. Re-run `verify.sh` at the frozen revision; report its engine-error scan as script/parse only.
5. Either assert admission and both provenance labels in the capture, or record the external
   admission read as the evidence and stop claiming the notice proves it.
