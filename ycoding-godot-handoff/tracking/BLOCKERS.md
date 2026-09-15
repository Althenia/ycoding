# Blocker register

No implementation blocker has been observed locally yet because the local audit has not run. Expected checks are not automatically blockers.

| ID | Status | Condition | Next action |
|---|---|---|---|
| CHECK-01 | pending_local_audit | Correct checkout, dirty state and applicable instructions unknown | TASK-001 |
| CHECK-02 | pending_local_audit | Installed Godot/toolchain and export templates unknown | TASK-002 |
| CHECK-03 | pending_asset_selection | No approved production asset family in this archive | TASK-005, then TASK-017 |
| CHECK-04 | pending_local_audit | Exact local API/auth/sync DTO mappings not yet recorded | TASK-004 |
| CHECK-05 | future_review_gate | Actual M2/M4 captures need user visual review when produced | TASK-024 / TASK-040 |

For actual blockers record owning task, evidence/error, safe work that can continue, smallest required user action and resolved date. Do not invent an access failure or request credentials just because the audit has not been attempted.
