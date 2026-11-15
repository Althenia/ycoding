# Bounded family decision watching

## Added

+ `ycoding decision watch --family --follow` accepts `--max-readers` to bound live Session subscriptions independently of family size (default 16, range 1–64), and `--max-pages` to bound each family discovery and task reconciliation (default and maximum 32768).

## Fixed

+ Continuous family watching covers large and changing families, including compaction descendants, through bounded live subscriptions and sequential retained-log replay. Busy, retry and idle transitions re-evaluate live membership; active members beyond the live pool remain covered through global invalidations and finite replay.
+ Retiring a subscription or temporarily losing family membership preserves acknowledged cursors, pending delivery and deduplication history. Re-entry resumes the latest acknowledged cursor. Existing version-1 state resumes without a reset or format conversion, within the 1 MiB state limit and 8192 retained-cursor limit.
+ Retained delivery waits until family observation is ready and its state save succeeds. Discovery or recovery-budget exhaustion retains recovery state instead of reporting readiness or discarding unresolved work.
+ A saved endpoint mismatch reports a specific sanitized `state-invalid` diagnostic. Recovery keeps the original endpoint binding, cursors and pending delivery; source invocations can select the original release server explicitly with `--server`.
