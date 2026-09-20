# R3-02 (resumed) — configuration bridge foundation

Lane: omoikane (DeepSeek v4.1 flash, high). Exclusive writer: `apps/office/integration/config_api.gd`,
`ui/settings/**`, `core/settings_{group,scope}.gd`, `app/main.gd`/`main.tscn` wiring, corresponding
tests + `tests/run_tests.gd`. Worktree: `/Users/viadz/Workspace/Project/ycoding.worktrees/office`.

**Not marked done by this lane.** This file records evidence only. Backend (`packages/**`) is another
owner's; **no TS/backend file was edited**.

## What changed since the R3-01 note

The earlier blocker is gone: an additive `server.config` group now exists live. Read and verified:

- `packages/protocol/src/groups/config.ts` — `GET /api/config`, `POST /api/config/preview`,
  `PUT /api/config`, all taking `LocationQuery` and returning `Location.response(...)`.
- `packages/schema/src/config.ts` — `Config.Read/Preview/Commit/Patch/Source/Change`,
  `Config.Scope = global|project|virtual`, `Config.WriteScope = global|project`, `REDACTED = "[redacted]"`.
- `specs/v2/configuration-api.md` — precedence folding, redaction list, JSONC edit-based writes,
  `unsettled` semantics, atomic rename.

Four contract facts drive the implementation:

1. **Every response is `{location, data}`** — the payload is `body["data"]`, not the body.
2. **Only `global` and `project` are writable.** There is no session scope and no separate folder
   scope: those are not configuration files. The R3-01 scope model was **corrected** to match, and
   both are now explained rather than silently absent.
3. **`expectedRevision` is the concurrency guard**, and a mismatch is HTTP 400.
4. **Reads rewrite secrets to `[redacted]`.** Re-sending that sentinel would store the placeholder
   in place of a credential, so the client refuses such a write **locally, before any request**.

## Changed paths

New (repository source):

- `apps/office/integration/config_api.gd` — the `server.config` client.
- `apps/office/core/config_review.gd` — read/preview/commit rules: effective value, per-key
  provenance, which scope a write targets, why a write is impossible, and the withheld-value guard.
- `apps/office/ui/settings/config_review_panel.gd` — the review surface: value rows with provenance,
  an editor, and an apply control that is armed **only** by a preview of the exact text it holds.

Modified (repository source):

- `apps/office/core/settings_scope.gd` — rewritten to the live contract (`ALL`/`WRITABLE`,
  `not_a_scope_explanation`, `badge`).
- `apps/office/core/settings_group.gd` — added `PAGE_KEYS` (each top-level key owned by exactly one
  page), `keys_for`, `no_key_reason`, `all_keys`, `page_for_key`.
- `apps/office/ui/settings/settings_panel.gd` — binds the review surface, corrected scope context.
- `apps/office/app/main.gd` — `config_api`/`config_review`, the three handlers, `_settle_config` in
  the frame loop, read-on-first-show.
- `apps/office/tests/run_tests.gd` — registers `test_config_bridge.gd`.
- `apps/office/tests/suites/test_settings_navigation.gd` — scope cases rewritten for the live model.
- `apps/office/tests/suites/test_config_bridge.gd` — new, 30 cases.

New (kit only):

- `ycoding-office-repair-kit/tools/config_stub_server.py` — throwaway loopback `server.config` stub.
- `ycoding-office-repair-kit/tools/r302_config_check.sh` — network harness.
- `ycoding-office-repair-kit/tools/r302_mutations.py` — mutation check.

## Evidence

Baseline before this lane's changes: **8663 / 0 / PASSED**, 0 engine errors.

### Full suite (no stub present)

```
passed: 9734  failed: 0  RESULT: PASSED   engine errors: 0
```

`verify.sh` (import + tests + flow, engine-error gated):

```
import         exit=0 engine_errors=0
tests          exit=0 engine_errors=0
flow           exit=0 engine_errors=0
  passed: 9734
  checks: 34, failures: 0
VERIFY: PASSED
```

The 12 wire-dependent cases print an explicit `SKIPPED:` line without a stub, so the suite never
claims coverage it does not have.

### Wire check against the real contract (throwaway loopback stub)

`sh ycoding-office-repair-kit/tools/r302_config_check.sh`:

```
SELFTEST PASSED: read/preview/commit, redaction, scope refusal, stale revision.
tests exit=0 engine_errors=0
passed: 9750  failed: 0  RESULT: PASSED
R302 config check exit=0
```

This exercises the REAL `ConfigApi` over the REAL `HttpTransport`: basic auth, the JSON body, the
`{location, data}` envelope, redaction, the stale-revision refusal, and the settled readback.

### Mutation check

`python3 ycoding-office-repair-kit/tools/r302_mutations.py`:

```
control: exit=0 passed=251 failed=0
redaction-guard-removed:       exit=1 passed=244 failed=7  DETECTED
session-scope-accepted:        exit=1 passed=247 failed=4  DETECTED
revision-guard-dropped:        exit=1 passed=249 failed=2  DETECTED
envelope-data-ignored:         exit=1 passed=237 failed=14 DETECTED
virtual-scope-writable:        exit=1 passed=245 failed=6  DETECTED
session-not-explained:         exit=1 passed=249 failed=2  DETECTED
commit-before-preview-allowed: exit=1 passed=250 failed=1  DETECTED
json-text-unchecked:           exit=1 passed=250 failed=1  DETECTED
apply-arms-without-preview:    exit=1 passed=247 failed=4  DETECTED
provenance-guard-removed:      exit=1 passed=247 failed=4  DETECTED
MUTATION CHECK PASSED: all 10 mutations produced failures
```

The check found two real coverage holes on its first run, both now fixed:

- **`session-scope-accepted`** was NOT detected: the only assertion that a session scope is refused
  lived on the wire path, which SKIPS without a stub. A recording-transport case now asserts the
  local refusal and that no request is issued at all.
- **`revision-guard-dropped`** was NOT detected: nothing asserted that `expectedRevision` is actually
  SENT. `test_the_guard_is_sent_whenever_a_revision_is_known` now asserts both the explicit-revision
  path and the path where the client falls back to the revision the read reported.

A third defect was found in the **stub**, not the client: its `sources` list kept a hardcoded
revision, so after its own commit a fresh read handed back an already-stale guard. Fixed with
`sync_source_revisions()`, and the stub's selftest now asserts that a read after a commit reports the
NEW revision and that a commit guarded by it succeeds.

## What is implemented, and what is not

Implemented and tested end-to-end: read effective values with provenance, per-page key ownership,
scope resolution to a writable document, preview-before-commit on the control itself, commit with the
preview's revision, settled readback adopted from the service, withheld-value refusal, non-JSON text
refusal, refusal surfacing with the service's own message, and `unsettled` reporting.

**Per-domain gaps, not claimed as implemented:**

- `providers`, `agents`, `commands`, `mcp`, `plugins`, `lsp`, `formatter`, `watcher`,
  `compaction`, `efficiency`, `attachments`, `tool_output`, `references`, `instructions` and the
  other record-valued keys are rendered as JSON text editors. The schema-guided editors for nested
  records, arrays, request overlays and custom policies that `ALL_SETTINGS.md` requires are **not**
  built.
- Secret-bearing fields are read as `[redacted]` and can be replaced with a new value, but there is
  no dedicated masked credential flow (R3-03).
- No `Remove` control is offered yet, although the API supports it (`null` value); the review
  explains the intent but does not expose a button.
- Pages that own no key (`appearance`, `keybindings`, `office`, `models`, `browser`, `updates`,
  `data`, `advanced`) state why; they are not implemented surfaces.
- Visual fidelity remains with the user's visual-spec workstream, as previously recorded.

## Native capture

`ycoding-office-repair-kit/tools/r301_capture.gd` boots the real `res://app/main.tscn`,
routes to Settings through `_on_route_requested`, and prints the review's actual state.

**No service attached** (the honest disconnected case — the review says so rather than
showing values):

```
R301 route=settings visible=true page=general scope=global
R301 config_state=loading values=0 sources=0 location=
R301 review_visible=true editing=false apply_available=false
R301 offered_scopes=["global", "virtual"]
```

**Fixture-backed** (`--fixture`, so the value/provenance rows are visible without a
service; the harness prints that the values come from itself and NOT from a service):

```
R301 fixture_backed=true (values come from the capture harness, not a service)
R301 config_state=ready values=5 sources=2 location=/fixture/office
R301 review_visible=true editing=false apply_available=false
```

Artifact: `ycoding-office-repair-kit/evidence/r3-02/r3-01-general.png`.

`apply_available=false` in both cases is the guarantee working: nothing is armed by
showing a page, and only a settled preview of the exact editor text arms it.

## Integration-review fixes (same owned paths)

Five defects the integration review found are fixed, each with a test that fails without
the fix and a mutation that proves the test discriminates.

1. **The Preview control did not exist.** `preview_requested` was declared and never
   emitted, so no user action could ever arm Apply. A real `Preview` button now emits it,
   and the tests drive `_preview.pressed.emit()` through to a committed write.
2. **A response could bless a superseded edit.** The root passed
   `surface.edited_key()/editor_text()` at RESPONSE time, so an edit made while a preview
   was in flight would have unvalidated text armed by an answer that validated different
   text. The request now captures key, text, scope and the guard revision when it is
   MADE, and the answer is compared against that identity.
3. **The scope selector never reached the write.** `write_scope_for` chose the effective
   owner on its own, so choosing Project would still have written Global. The review now
   holds `chosen_scope`; a choice overrides the effective owner, the guard comes from the
   chosen document's revision, and a scope change invalidates an armed preview.
4. **`_sync_apply` computed readiness and ignored it.** Apply and Preview are now disabled
   while the review is not READY and while any call is in flight, so a duplicate Apply
   cannot write twice and a read cannot start over a pending commit.
5. **The location rebind did not cancel.** `select_folder` never rebound the config
   reader, and `ConfigApi.configure` did not cancel an in-flight request when the
   transport changed. Both are fixed, so switching projects cannot land the old project's
   answer on the new one.

| Check | Result |
|---|---|
| `verify.sh` (import+tests+flow) | **PASSED** — 9805 / 0, 34 flow checks, 0 engine errors |
| `r302_config_check.sh` (real transport vs loopback stub) | **PASSED** — 9821 / 0, 0 engine errors |
| `r302_mutations.py` | **all 17 mutations DETECTED** |

The mutation sweep found three further problems, all fixed:

- `commit-before-preview-allowed` was masked, which exposed a **dead test**: the case
  existed but was never wired into `run()`, so it never ran. The same audit found one more
  dead test in `test_settings_navigation.gd`. Both are now wired, and a name-diff check
  over `run()` is recorded here as the guard.
- `apply-ignores-review-readiness` was masked by the text check; the case now arms a
  preview while READY and then rebinds to an unread reader, so only the readiness guard
  can keep Apply disabled.
- A new case's own assertion used `request["method"] == METHOD_POST`, which is the verb
  constant for GET; corrected to assert no `PUT` was issued.

## Remove action (this step)

A `Remove` control is now offered per key, through the same revision-aware preview/commit
path as an edit. No credential editor was added.

**When Remove is offered, and why otherwise:**

| Situation | Treatment |
|---|---|
| The target document defines the key | `Remove` is shown and can act |
| No document defines the key | No control; the row states that nothing defines it |
| The value is withheld (`[redacted]`) | No control; the reason states that removing a credential is a separate flow |
| The chosen document does not define the key the value comes from | No control; the reason names the document that does own it |

The last two rows are the clause that keeps this honest: the API removes a key by writing
`null` to the TARGET document, so removing a key that document does not define would write
nothing while appearing to delete something. That case is refused with the owning document
named, rather than being offered as a dead action.

**On the wire** a removal is a `null` value for the key, guarded by the same
`expectedRevision`. The panel tracks that the armed validation was a REMOVAL, so a removal
cannot be committed from an edit's validation or the reverse; a scope change invalidates it
exactly as it does an edit.

### Evidence

| Check | Result |
|---|---|
| `verify.sh` (import+tests+flow) | **PASSED** — 9849 / 0, 34 flow checks, 0 engine errors |
| `r302_config_check.sh` (real transport vs loopback stub) | **PASSED** — 9865 / 0, 0 engine errors |
| `r302_mutations.py` | **all 23 mutations DETECTED** (was 17) |

The sweep found three defects in the CHECK rather than the code, all fixed:

- The single-suite driver's `quit(0)` made every mutation read as `NOT DETECTED`; detection
  now keys on the assertion counts, since a driver whose exit code does not reflect
  failures is a defect in the checker.
- A mutation pattern matched **two** sites (the pre-preview guard exists on both the edit
  and the removal commit path), so the tool mutated whichever came first - meaning a
  `NOT DETECTED` verdict could be about code the label did not name. The tool now refuses
  an ambiguous pattern, and the offending mutation was re-anchored to the text-identity
  guard, which is unique. The same guard was added to the R3-01 tool.
- The test fixture's transport double keyed answers by path only, but `/api/config` serves
  both the GET read and the PUT commit, so a read returned a commit body. Answers are now
  keyed by method and path.

Two test-premise errors were also corrected rather than worked around: a "withheld" reason
was matched against the substring "withhold", and the unsettled-removal case used a read
where the project document did not define the key, so there was no project override to
remove.

## Integration-review round 2: reachable gaps in the Remove flow

Five defects found by review, fixed in the same owned paths, each with a test that fails
without the fix and a mutation that proves the test discriminates.

1. **The Remove flow was not reachable by a user.** `press_remove` set the removal intent
   but never showed `_editor_box`, and Apply lives inside it, so `apply_available()` was
   false forever. The editor box (with its own Preview and Apply) is now shown for a
   removal, with the editor text hidden -- a removal has no text to edit.
2. **A settle for another key could arm.** The settle handler compared only revision and
   text, so a late answer for a different key could arm an intent it did not validate.
   The pending removal is keyed, and an answer for another key is ignored.
3. **The guard used the first matching document, not the target.** The backend's
   `targetOf` resolves a scope's document with `findLast`, but the client used the first
   matching source, so with several documents in one scope the `expectedRevision` came
   from a document the write would not target and the commit was refused. Both
   `ConfigReview.revision_for_scope` and `ConfigApi.target_revision` now take the last
   matching source of that scope.
4. **Nested withheld values were not detected.** `remove_refusal` checked only a
   top-level sentinel, so a key whose value contained a redaction `TOKEN` deeper in an
   object could be offered for removal. The withheld check now walks the value and names
   the path that is withheld.
5. **Preview could act during a pending removal.** Preview is now disabled while a
   removal is pending, so an enabled control that could not do anything is not offered.

### Evidence

| Check | Result |
|---|---|
| `verify.sh` (import+tests+flow) | 9912 passed — **10 failures, all in `test_provider_credentials.gd`** (see below); **0 naming this lane's files**, 0 engine errors in its modules |
| `test_config_bridge.gd` | **400 / 0** |
| `test_settings_navigation.gd` | **783 / 0** |
| `r302_mutations.py` | **all 29 mutations DETECTED** (was 23) |
| `config_stub_server.py --selftest` | PASSED |

The 10 failures are the asset-provenance scan (`test_no_credential_is_bundled`) flagging
ten `sk-...` literals in `tests/suites/test_provider_credentials.gd`, which is another
lane's new, unregistered file (it is not in `run_tests.gd`, so its own assertions never
run). `CREDENTIAL_ALLOW_LIST` exists precisely for a reviewed synthetic literal but is
not consulted for `SECRET_MATERIAL_PATTERN`; the credential lane must either allow-list
that file, use a non-`sk-` synthetic literal, or derive the literal. Not edited here.

### Name-diff guard for dead tests

Every `test_*` function in a suite is checked against the names wired into `run()`. After
the sweep this reported `defined=… wired=… missing=[] extra=[]` for both suites; the two
dead tests it found earlier (`test_a_commit_without_a_validated_revision_is_refused`,
`test_a_session_scope_is_never_offered`) are wired.

## Documentation

Held by parent, who corrected `docs/configuration.md`, `docs/runtime.md` and
`apps/office/AGENTS.md` for the already-implemented bridge and scopes. Not edited here.
One remaining suggestion for the parent's files: the wire-reference note could cite the
config group alongside the session-event and route owners.