# Evidence JSON entry instructions

Append actual records to `tracking/evidence.json` → `records`. Do not copy hypothetical results as executed evidence.

Required fields:
`id` (unique), `kind`, `result`, `synthetic` (boolean), `recorded_at`, `summary`, `repo_revision`, `dirty_state`, `steps_or_command`, `artifacts` (kit-relative files), `redaction_reviewed` (boolean).

Kinds: `source_audit`, `test_run`, `native_runtime`, `visual_capture`, `layout_capture`, `real_provider`, `user_review`, `build`.
Results: `pass`, `fail`, `blocked`, `not_run`.

For a passing record, time/revision/dirty state must be real, artifacts must exist, redaction_reviewed must be true. Use a private audit note for an unversioned checkout rather than inventing a SHA. `synthetic: true` cannot close an implementation task; a test run can be non-synthetic evidence of actually executed tests even when isolated test inputs are fixtures. Describe those boundaries accurately.

`real_provider` additionally records actual provider/model and desktop path exercised. `layout_capture` is output measured by running UI controls, not the bundled template. `user_review` records the user's actual approval text/date/context and its artifact. Task `evidence` arrays refer to record IDs, not file paths.

The structural validator cannot prove truthfulness. Inspect every artifact and claim yourself before marking done.
