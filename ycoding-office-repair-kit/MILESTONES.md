# Repair and completion milestones

These replace the earlier draft R0–R7 sequence. All application work is initially unverified. Parallel work is allowed when task dependencies permit.

## R0 — Independent local audit

**Objective:** Reproduce the current app, TUI baseline and reported failures before trusting old completions.

**Scope/tasks:** R0-01, R0-02, R0-03, R0-04, R0-05, R0-06, R0-07, R0-08

**Dependencies:** none

**Acceptance:** All tasks verified with current source and required native evidence; no unresolved mandatory gap.

**Verification:** See TEST_PLAN.md and ACCEPTANCE.md; fixture tests are not real-provider/native signoff.

## R1 — Real runtime and no production demo

**Objective:** An ordinary desktop prompt completes through the actual configured provider, or fails honestly.

**Scope/tasks:** R1-01, R1-02, R1-03, R1-04, R1-05, R1-06, R1-07

**Dependencies:** R0-08

**Acceptance:** All tasks verified with current source and required native evidence; no unresolved mandatory gap.

**Verification:** See TEST_PLAN.md and ACCEPTANCE.md; fixture tests are not real-provider/native signoff.

## R2 — Office-first multipage shell

**Objective:** Sidebar, office, composer and rich pages resize as one coherent app.

**Scope/tasks:** R2-01, R2-02, R2-03, R2-04, R2-05, R2-06, R2-07

**Dependencies:** R0-08

**Acceptance:** All tasks verified with current source and required native evidence; no unresolved mandatory gap.

**Verification:** See TEST_PLAN.md and ACCEPTANCE.md; fixture tests are not real-provider/native signoff.

## R3 — Complete working settings

**Objective:** Every live setting/action has an explicit treatment and required controls work end-to-end.

**Scope/tasks:** R3-01, R3-02, R3-03, R3-04, R3-05, R3-06, R3-07, R3-08, R3-09, R3-10, R3-11, R3-12

**Dependencies:** R1-07, R2-07

**Acceptance:** All tasks verified with current source and required native evidence; no unresolved mandatory gap.

**Verification:** See TEST_PLAN.md and ACCEPTANCE.md; fixture tests are not real-provider/native signoff.

## R4 — Fine-grained office and user walking

**Objective:** A polished, truthful office with a user-controlled avatar.

**Scope/tasks:** R4-01, R4-02, R4-03, R4-04, R4-05, R4-06, R4-07, R4-08

**Dependencies:** R0-08

**Acceptance:** All tasks verified with current source and required native evidence; no unresolved mandatory gap.

**Verification:** See TEST_PLAN.md and ACCEPTANCE.md; fixture tests are not real-provider/native signoff.

## R5 — Multiple projects and folders

**Objective:** Independent locations, drafts and active work coexist safely.

**Scope/tasks:** R5-01, R5-02, R5-03, R5-04, R5-05, R5-06, R5-07

**Dependencies:** R0-08

**Acceptance:** All tasks verified with current source and required native evidence; no unresolved mandatory gap.

**Verification:** See TEST_PLAN.md and ACCEPTANCE.md; fixture tests are not real-provider/native signoff.

## R6 — Conversation and TUI capability parity

**Objective:** Inspect and control real work in rich desktop views.

**Scope/tasks:** R6-01, R6-02, R6-03, R6-04, R6-05, R6-06

**Dependencies:** R1-07, R2-07

**Acceptance:** All tasks verified with current source and required native evidence; no unresolved mandatory gap.

**Verification:** See TEST_PLAN.md and ACCEPTANCE.md; fixture tests are not real-provider/native signoff.

## R7 — Statistics, quota and budgets

**Objective:** Useful rich analytics without inventing balances or miscounting usage.

**Scope/tasks:** R7-01, R7-02, R7-03, R7-04, R7-05, R7-06, R7-07, R7-08, R7-09

**Dependencies:** R1-07, R2-07, R5-07

**Acceptance:** All tasks verified with current source and required native evidence; no unresolved mandatory gap.

**Verification:** See TEST_PLAN.md and ACCEPTANCE.md; fixture tests are not real-provider/native signoff.

## R8 — Recovery, accessibility and regression

**Objective:** The repaired flows survive real failures and ongoing work.

**Scope/tasks:** R8-01, R8-02, R8-03, R8-04, R8-05, R8-06

**Dependencies:** R3-12, R4-08, R5-07, R6-06, R7-09

**Acceptance:** All tasks verified with current source and required native evidence; no unresolved mandatory gap.

**Verification:** See TEST_PLAN.md and ACCEPTANCE.md; fixture tests are not real-provider/native signoff.

## R9 — Build and local installation

**Objective:** Repeatable verified CLI + Office candidates on supported hosts.

**Scope/tasks:** R9-01, R9-02, R9-03, R9-04, R9-05, R9-06, R9-07, R9-08

**Dependencies:** R0-08

**Acceptance:** All tasks verified with current source and required native evidence; no unresolved mandatory gap.

**Verification:** See TEST_PLAN.md and ACCEPTANCE.md; fixture tests are not real-provider/native signoff.

## R10 — GitHub Release and website delivery

**Objective:** Existing release pipeline publishes real artifacts and the existing website links them.

**Scope/tasks:** R10-01, R10-02, R10-03, R10-04, R10-05, R10-06

**Dependencies:** R8-06, R9-08

**Acceptance:** All tasks verified with current source and required native evidence; no unresolved mandatory gap.

**Verification:** See TEST_PLAN.md and ACCEPTANCE.md; fixture tests are not real-provider/native signoff.
