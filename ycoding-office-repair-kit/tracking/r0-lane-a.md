# R0-01 / R0-03 — Lane A: checkout reconciliation, ownership and wire-contract audit (read-only)

Repo `/Users/viadz/Workspace/Project/ycoding`, branch `main`, HEAD `a4bb99e`.
Read-only on all repository source. The only file created is this note.
No `git` mutation, no Godot run (deferred to lane C per constraint).
Every claim carries `path:line` or a command transcript.

---

## 1. State

| Fact | Evidence |
|---|---|
| Branch/HEAD | `# branch.oid a4bb99ed1cd43766985c0752fa8f55209496c2c9`, `# branch.head main` |
| Upstream | `# branch.upstream origin/main`, `# branch.ab +1 -0` (one unpushed local commit) |
| Working tree | clean except one untracked directory: `? ycoding-office-repair-kit/` |
| `git diff --stat` | empty (no unstaged changes) |
| `git diff --cached --stat` | empty (nothing staged) |
| Kit pin | `ycoding-office-repair-kit/tracking/tasks.json` → `"source_revision": "77ef4315fa66a8c51c4288e00bfa0a77a635eb63"` |
| Pin resolvable | `git cat-file -t 77ef431…` → `commit`; the pin is `HEAD~1` |

Command transcript (verbatim, trimmed):

```
$ git status --porcelain=v2 --branch
# branch.oid a4bb99ed1cd43766985c0752fa8f55209496c2c9
# branch.head main
# branch.upstream origin/main
# branch.ab +1 -0
? ycoding-office-repair-kit/

$ git diff --stat        # (no output)
$ git diff --cached --stat   # (no output)
```

Concurrent-writer note: this lane's first read of `tracking/tasks.json` reported 84 tasks, all `not_started`. A later read of the same file reported `Counter({'not_started': 83, 'done': 1})` with `R0-08 done` and `tracking/evidence.json` grew from 1 to 10 records. Another lane (E) is writing the kit while this audit runs; the repository source itself is untouched (`git status --porcelain` unchanged).

## 2. Commits since the kit pin

`git log --oneline 77ef4315fa66a8c51c4288e00bfa0a77a635eb63..HEAD` returns exactly **one** commit, and
`git rev-list --count 77ef431…..HEAD` → `1`.

| Commit | Subject | Files changed (`git show --stat`) | Under `apps/office/` |
|---|---|---|---|
| `a4bb99e` | `chore(release): add v0.2.5 release notes` | `docs/releases/v0.2.5.md`, `packages/tui/src/config/keybind.ts`, `packages/tui/test/prompt-paste.test.tsx` | **none** |

`git diff --name-status 77ef431…..HEAD`:

```
A   docs/releases/v0.2.5.md
M   packages/tui/src/config/keybind.ts
M   packages/tui/test/prompt-paste.test.tsx
```

**Drift verdict: 1 commit, 3 files, all outside `apps/office/`.** The kit's pinned revision is an ancestor of HEAD and the entire Office client, Protocol/Schema and delivery chain are byte-identical to the pin (verified independently in §4 via Git blob hashes).

## 3. Already-done kit tasks (strict)

**None.** A kit task is "already done" only with concrete file+code evidence, and the only obligation this lane audited is the Office surface.

- Zero commits since the pin touch `apps/office/` (§2 name-status). A committed Office task therefore cannot exist that the pin did not already contain.
- All 84 kit tasks are `not_started` in the initial read; the later read shows `R0-08 done` written by lane E, not by a source commit. That is ledger progress, not superseded source work.
- Task titles that describe existing modules (R2-02 scale/layout, R2-03 composer, R6-01 history) are **not** done: the modules exist but the task acceptance criteria are delta requirements. Evidence of the gap, all live:
  - `R2-03` requires Enter/Shift+Enter submit; `apps/office/ui/prompt/prompt_panel.gd:57` builds a `TextEdit` (multiline) and the panel submits only on modified Enter (also captured by lane D as `ev-r0-02-composer-submit-parity`).
  - `R4-04` requires a user-controlled player avatar; `grep -rln "player\|avatar" apps/office` returns **no** match.
  - `R7-03` requires a statistics route/charts; `grep -rln "usage\|quota\|statistics" apps/office/{ui,app,core,integration}` returns **no** match.
  - `R3-01` requires settings navigation; no settings surface exists (`settings` matched only `prompt_panel.gd`, `main.gd`, `motion.gd` for unrelated strings).
  - `R5-02` requires recent/pinned project navigation; no project-switch surface exists.
- `R9-04` "Verify archive/version/checksum contract" is **partially** satisfied in source (not verified at runtime): `apps/office/tools/build-release.sh:131,153,166` emits the three required names, `:141-143` enforces the macOS bundle version, `:184` writes one checksum line, and `apps/office/tests/suites/test_release_identity.gd:21` pins `0.2.4`. But the checked-in version is stale against HEAD: `apps/office/project.godot:14` is `config/version="0.2.4"` while `docs/releases/` now ends at `v0.2.5.md`. Runtime verification is deferred to lane C.

## 4. Merge-safety of kit integration files

### 4a. Guarded baselines (kit `existing_files`) vs live tree

Hashes are Git blob SHA-1 (`git hash-object <path>`, `git rev-parse <rev>:<path>`).

| Kit path | BASELINE `git_blob_sha1` | Live blob | At pin | Verdict |
|---|---|---|---|---|
| `.github/workflows/release.yml` | `b0c1cf274d8cc50cb137c42bd6d52dd8ca043f4b` | `b0c1cf27…` | `b0c1cf27…` | exact |
| `.github/workflows/pages.yml` | `c837bd27048fcbce6edcadfdee1b2463681a88b1` | `c837bd27…` | `c837bd27…` | exact |
| `apps/office/tools/verify-integration.sh` | `a547b6bfa56ae96ef4502391329314ef87f9c6cc` | `a547b6bf…` | `a547b6bf…` | exact |

`ycoding-office-repair-kit/integration/BASELINE.json` is therefore accurate for this checkout.

### 4b. Merger preview on the live tree (read-only; `--apply` NOT passed)

```
$ python3 ycoding-office-repair-kit/tools/merge_delivery.py --repo .
replace .github/workflows/release.yml
replace .github/workflows/pages.yml
replace apps/office/tools/verify-integration.sh
add     .github/workflows/office-ci.yml
add     Taskfile.office.yml
add     script/install-office.ps1
add     script/office_readiness.py
add     script/office_release.py
add     script/office_tasks.py
add     script/office_tests/test_delivery.py
add     script/setup_office_godot.py
Preview only. No target file changed.
exit=0
```

Zero drift refusals. `tools/merge_delivery.py:49` refuses on `blob(data)!=expected[rel]`; `:55` refuses if an addition destination exists; `:78-86` re-checks concurrency before each write and rolls back on failure. All 8 addition destinations are absent live (`dest.exists()` false), so additions are safe adds.

### 4c. Safe-to-merge vs drifted

| Kit item | Classification | Basis |
|---|---|---|
| `replacements/apps/office/tools/verify-integration.sh` | **Safe to merge** | Baseline exact; replacement itself is a genuine improvement (import stage, per-stage logs, `SCRIPT ERROR`/`FAIL:` scan across all logs, `trap cleanup 0`). |
| `replacements/.github/workflows/pages.yml` | **Safe on drift-gate; review the trigger policy before merging** | Baseline exact. Content adds `workflow_run` on `release` and pinned `ref: main`, and changes `deploy` to `github.ref == 'refs/heads/main' \|\| github.event_name == 'workflow_run'` — a real CI/CD policy change. Approval for CI/CD changes is required. |
| `replacements/.github/workflows/release.yml` | **Safe on drift-gate; transform is marker-based** | Not shipped as a file. `merge_delivery.py:45-52` transforms live bytes and verifies the result against BASELINE. Verified in memory (no write): all 9 markers resolve (`YCODING_CHANNEL: latest` ×1, `"${{ inputs.version }}"` ×8, `"${{ github.ref_name }}"` ×9, `build the desktop client` ×1, `build-release.sh …` ×1, `Upload prepared release assets` ×1, `Create GitHub release` ×1, `name: publish release` ×1); the resulting diff is 95 lines and inserts exactly one `fetch-depth: 0`. |
| 8 `additions/**` files | **Safe to add** | Every destination absent live. |

Kit-internal integrity caveat: `shasum -a 256 -c MANIFEST.sha256` reports `TODO.md`, `TRACKING.md`, `tracking/evidence.json`, `tracking/tasks.json` as `FAILED` — expected, because other lanes are already editing those handoff ledgers. No repository source file is affected.

## 5. Ownership map

| Concern | Owner | Evidence |
|---|---|---|
| App boot / composition root | `apps/office/app/main.gd` (`class_name OfficeMain`) | `main.gd:4-5` "Selects exactly one transport, owns the store, and wires the director"; `_ready()` at `:49` builds store/director/transports/panels and calls `_start_demo()` at `:95` |
| Transport selection | `apps/office/app/main.gd` only | `main.gd:4` "This is the only place that decides DEMO vs LIVE"; `start_live` `:153`, `start_demo_mode` `:219`, `_on_mode_toggle` `:242` |
| Transport implementation | `integration/live_transport.gd`, `integration/demo_transport.gd`, `integration/http_transport.gd`, `integration/sse_parser.gd` | `live_transport.gd:12`, `demo_transport.gd:6`, `http_transport.gd:21`, `sse_parser.gd:9` |
| Wire vocabulary (event names) | `apps/office/core/wire.gd` (`class_name Wire`) | `wire.gd:6-64` constants |
| Route/payload contract | `apps/office/integration/gateway_contract.gd` (`class_name Gateway`) | `gateway_contract.gd:11-67` routes, `:69-104` framing |
| Store / reducer / read model | `apps/office/core/office_store.gd` (`OfficeStore`) | `office_store.gd:6-8`; `apply()` match from `:268`; actor/presence/attention projections throughout |
| Presence (seating) | `apps/office/core/presence.gd` | `presence.gd:11` `const AT_WORK/PLAYING/WAITING/LEFT` |
| Attention queue | `apps/office/core/attention_queue.gd` | `attention_queue.gd:15-17` kinds; `:20` `REPLIES` |
| Work-state classification | `apps/office/core/work_state.gd` | `work_state.gd:4-14` `Kind` enum |
| Model catalogue logic | `apps/office/core/model_catalog.gd` + `integration/model_catalog_api.gd` | `model_catalog.gd:12`; `model_catalog_api.gd:22` `class_name ModelCatalogApi` |
| Session lifecycle mutations | `apps/office/integration/session_api.gd` | `session_api.gd:16`; `create_path()` `:54`, `interrupt_path()` `:59` |
| Service discovery | `apps/office/integration/service_registration.gd` | `service_registration.gd:8`; `candidates()` `:19-30` |
| Layout (window frame) | `apps/office/ui/shell/office_shell_layout.gd` | `office_shell_layout.gd:33-67` metrics; `overlays()` from `:86` |
| Theme/palette/scale | `ui/shell/office_theme.gd`, `ui/theme/office_palette.gd`, `app/ui_scale.gd` | referenced by `main.gd` `_cycle_theme`/`_cycle_scale` |
| Shortcuts (pure map) | `apps/office/app/shortcuts.gd` | `shortcuts.gd:2-3` "pure mapping … never touches a node" |
| Scene / world | `office/maps/hq/office_world.gd` (plan), `office/navigation/office_navigation.gd` (raster/routing), `office/viewport/office_viewport.gd` (SubViewport), `office/actors/office_actor.gd` | `office_world.gd:46-47` `MAP_WIDTH := 41`, `MAP_HEIGHT := 23`, `:58` `DIVIDERS := [26]`; `office_navigation.gd:7` AStarGrid2D |
| Cosmetic director | `apps/office/office/director/office_director.gd` | `office_director.gd:6` "consumes presentation state and emits local visual actions only" |

Boundary note for the orchestrator: `apps/office/AGENTS.md:29-35` documents the world as "40 x 21 tiles = 1280 x 672 px, aspect 1.905", rows 2-9 / 12-19, six rooms with dividers at cols 12 and 26. The live plan is 41×23 (aspect 1.783), rows 2-10 / 13-21, one divider at col 26 (`office_world.gd:46-47,58`), and the suite pins `41.0/23.0` (`apps/office/tests/suites/test_shell_layout.gd:10`). The package guide contradicts its own code and test (also recorded by lane D as `ev-r0-03-world-plan-doc-drift`).

## 6. Wire-contract diff (highest-value section)

### 6a. Kit contract inventory, against live

The kit ships **two** contract artifacts and **no wire record**:
`ls ycoding-office-repair-kit/contracts/` → only `verification-cases.json`.

- `contracts/verification-cases.json` contains windows, text scales, themes, required UI states and a capture descriptor. It names **zero** routes, DTOs or events — so it makes no wire claim to falsify.
- `find . -name 'wire-audit*'` → **no match** anywhere in the checkout or the kit. `find ycoding-office-repair-kit -iname '*wire*'` → no match.

Every identifier in the kit that does resolve is correct:

| Kit name | Live name | Verdict | Evidence |
|---|---|---|---|
| `/api/provider/usage` | `/api/provider/usage` | exists | Kit `docs/STATISTICS_AND_QUOTAS.md:13` vs `packages/protocol/src/groups/provider-usage.ts:23` |
| `/api/provider/:providerID/usage` | same | exists | same kit line vs `provider-usage.ts:38` |
| `ProviderUsage.Snapshot` / `.Window` | `ProviderUsage.Snapshot` / `.Window` | exists | kit `docs/STATISTICS_AND_QUOTAS.md:13`; `provider-usage.ts:25,40` (`Schema.Array(ProviderUsage.Snapshot)`) |
| `credential.update` "changes a LABEL" | `credential.update` PATCH payload `{ label: string }` | exists | kit `docs/ALL_SETTINGS.md:17` vs `packages/protocol/src/groups/credential.ts:8-11` |
| `"session.sidebar"` etc. as configuration paths | live TUI config paths (`session.sidebar`, `session.scrollbar`, `session.thinking`, `session.grouping`) | exists as config, not as wire | kit `docs/SETTINGS_CATALOG.md:166-169`, `tracking/settings_catalog.json:1918,1930,1942,1954` vs `packages/tui/src/component/dialog-config.tsx:53,60,68,75` and `docs/configuration.md:975-978` |

No kit route/DTO/event name was found that does **not** exist in the live protocol.

### 6b. Dangling authority citation (kit defect, high severity)

| Subject | Evidence |
|---|---|
| Live repo guide cites the kit file as authority | `apps/office/AGENTS.md:9` — "`contracts/wire-audit.json` in the handoff pack records the locally verified operations, DTOs, auth, location scope, and the real event vocabulary. Treat it as the wire reference." |
| Live source cites it again | `apps/office/core/wire.gd:1` — "Real YCoding wire vocabulary, verified in `contracts/wire-audit.json`." |
| Live source cites it a third time | `apps/office/integration/fixture_translator.gd:8` — "Verified real vocabulary: contracts/wire-audit.json -> actual_event_vocabulary" |
| The file does not exist | `find` above; kit `contracts/` holds only `verification-cases.json`; `MANIFEST.sha256:13` lists only `contracts/verification-cases.json` |

The constants are nonetheless recoverable and correct: `wire.gd:3-4` names the live sources (`packages/schema/src/session-event.ts`, `event-manifest.ts`). Spot-checked against live: `server.connected`, `session.created`, `session.execution.started/succeeded/failed/interrupted`, `session.task.updated`, `session.step.started/ended/failed`, `session.text.started`, `session.input.admitted/promoted`, `session.file-change.recorded`, `session.compaction.started/admitted/ended/failed`, `session.deleted/archived/unarchived`, `permission.v2.asked` (`packages/schema/src/permission.ts:43`), `guardrail.asked` (`packages/schema/src/guardrail.ts:83`), `session.status` with `idle|busy|retry` (`packages/schema/src/session-status-event.ts:36,12-33`) — all present. `log.synced` + `aggregateID` + `seq` framing (`gateway_contract.gd:86-93`) matches `packages/schema/src/event-log.ts:13-16`.

### 6c. Live routes the office client calls, and where they are (or are not) in the kit

The kit has no route inventory, so every office-called route is absent from the kit. Verdicts below are against the **live protocol**, which is what matters for correctness.

| Office route (`apps/office/integration/gateway_contract.gd`) | Live route | Verdict | Evidence |
|---|---|---|---|
| `/api/health` (`:15`) | `health.get` `/api/health` | correct | `packages/protocol/src/groups/health.ts:30` |
| `/api/event` (`:16,23`) | `event.subscribe` `/api/event` (SSE) | correct | `packages/protocol/src/groups/event.ts:36` |
| `/api/session` GET (`:17`) | `session.list` `/api/session` | correct | `packages/protocol/src/groups/session.ts:263` |
| `/api/session` POST (`session_api.gd:56`) | `session.create` `/api/session` | correct | `session.ts:283` |
| `/api/session/active` (`:18`) | `session.active` `/api/session/active` | correct | `session.ts:302` |
| `/api/session/:id` (`:30`) | `session.get` | correct | `session.ts:314` |
| `/api/session/:id/snapshot` (`:33`) | `session.snapshot` | correct | `session.ts:329` |
| `/api/session/:id/message` (`:36`) | `session.messages` | correct | `packages/protocol/src/groups/message.ts:9` |
| `/api/session/:id/prompt` (`:39`) | `session.prompt` | correct | `session.ts:610` |
| `/api/session/:id/interrupt` (`:42`) | `session.interrupt` | correct | `session.ts:970` |
| `/api/session/:id/model` (`:48`) | `session.switchModel` | correct | `session.ts:561` |
| `/api/session/:id/subagent` (`:51`) | `session.subagent.list`/`.launch` | correct | `session.ts:437,453` |
| `/api/experimental/session/:id/log?after&follow` (`:70`) | `session.log` | correct | `session.ts:948` |
| `/api/model` (`:27`) | `model.list` | correct | `packages/protocol/src/groups/model.ts:10` |
| `/api/session/:id/question/:req/reply` (`:56`) | `session.question.reply` | **route exists** | `packages/protocol/src/groups/question.ts:52` |
| `/api/session/:id/question/:req/reject` (`:59`) | `session.question.reject` | **route exists** | `question.ts:68` |
| `/api/session/:id/permission/:req/reply` (`:62`) | `session.permission.reply` | correct | `packages/protocol/src/groups/permission.ts:119` |
| `/api/session/:id/guardrail/:req/reply` (`:65`) | `session.guardrail.request.reply` = `/api/session/:sessionID/guardrail/request/:requestID/reply` | **MISMATCH — segment `request` missing** | office `gateway_contract.gd:64-65` vs `packages/protocol/src/groups/guardrail.ts:44-45` and `specs/v2/session-guardrails.md:95` |
| Gateway envelope `MESSAGES_CURSOR := "cursor"` (`:97`) | message list success is `{ data: Array(SessionMessage.Info) }` — **no `cursor`** | **unsupported constant** | `gateway_contract.gd:96-97` vs `packages/protocol/src/groups/message.ts:10-13` |

Subagent orchestration question answering — a second semantic mismatch:

| Office behaviour | Live contract | Verdict | Evidence |
|---|---|---|---|
| Office queues an orchestration question from `session.task.updated` `change.type == "question_asked"` with the id at `change.question.id` | `SessionOrchestration.Change` member `question_asked` carries `Question` with `id: QuestionID` | correct shape | office `office_store.gd:524-537` vs `packages/schema/src/session-orchestration.ts:196`, `:72-77` |
| Those ids are `qst_`-prefixed | `QuestionID` requires prefix `qst_` | correct | `packages/core/src/session/orchestration.ts:671`; `session-orchestration.ts:63` |
| Office answers them through `session.question.reply`, whose param is `Question.ID` | `Question.ID` requires prefix `que` | **MISMATCH — `qst_…` cannot satisfy `que`** | office `live_transport.gd:361` + `gateway_contract.gd:56` vs `packages/schema/src/question.ts:10` and `question.ts:53` |
| Office sends `{"answers": [[label]]}` | `Question.Reply` = `{ answers: Array<Array<string>> }` | payload shape matches, but for the wrong question family | office `attention_queue.gd:108-119` vs `question.ts:63-67` |
| Office never subscribes to `question.v2.asked` | The `que_` family is published as `question.v2.asked` | **wire event not subscribed** (absent from `wire.gd`) | `grep -c "question.v2" apps/office/core/wire.gd` → `0`; publisher `packages/core/src/question.ts:111` |
| Live answer path for orchestration questions is `POST /api/session/:parentID/subagent/:childID/question/:questionID/answer` with `{ text?, data? }` | office does not call it | **missing office capability** | `packages/protocol/src/groups/session.ts:479-481,219-222` |

Also unsupported by the live schema: office's permission reply is `{"reply": "once"|"always"|"reject"}` (`attention_queue.gd:126-129`) which matches `Permission.Reply` (`packages/schema/src/permission.ts:36`), and guardrail reply matches `Guardrail.Reply` (`packages/schema/src/guardrail.ts:63`) — those two payloads are correct; only permission/guardrail **paths** (guardrail) and the question **family routing** are wrong.

## 7. Transport selection (real logic)

Production selection lives only in `apps/office/app/main.gd`.

1. **Boot is unconditionally DEMO.** `_ready()` (`main.gd:49`) ends with `_start_demo()` (`:95`). `_start_demo()` (`:134`) sets `store.mode = OfficeStore.MODE_DEMO` (`:135`), loads `DEMO_FIXTURE := "res://fixtures/oauth-workplace.jsonl"` (`:8`), connects `demo.event_ready` (`:141`) and calls `demo.play(true)`.
2. **`demo_transport.gd` is the DEMO path.** It has no network capability; `DemoTransport.load_fixture` (`demo_transport.gd:22`) parses JSONL and translates each record via `FixtureTranslator.translate` (`demo_transport.gd:38`).
3. **`fixture_translator.gd` is reached only from `demo_transport.gd:38`.** No other caller exists (`grep -rn FixtureTranslator apps/office --include='*.gd'` → `demo_transport.gd:4,6,9,38`). It maps five fixture-only labels (`FIXTURE_CONNECTION`, `FIXTURE_OBSERVED`, `FIXTURE_ACTIVITY`, `FIXTURE_INTERACTION`, `FIXTURE_SETTLED`; `fixture_translator.gd:15-19`) onto `Wire` names, so it is not on any live path.
4. **LIVE requires two explicit actions, never automatic.** `start_live(base_url, password)` (`main.gd:153`) validates the address first (`:154`), stops the demo (`:158` → `_stop_demo` `:231`), discards demo state by replacing the store (`:163-165`), sets `MODE_LIVE` (`:168`), connects `live.event_ready`/`connection_changed`/`failure`/`reload_*` (`:169-176`), builds dedicated `SessionApi`/`ModelCatalogApi` transports via `_side_transport()` (`:192`), then `live.play()` (`:180`).
5. **The reachable LIVE entry point is the sidebar product button.** `_on_mode_toggle()` (`main.gd:242`) is connected to `sidebar.mode_toggle_requested` (`:77`), emitted from `apps/office/ui/shell/sidebar_panel.gd:78`. `start_live` has no other caller in production (grep: `main.gd:153` definition, `main.gd:251` call inside `_on_mode_toggle`). `main.gd:150-152` still carries the stale comment "LIVE requires an explicit connection and is not implemented in this milestone", which contradicts the implemented code below it.
6. **The address is discovered, not typed.** `_read_service_registration()` (`main.gd:264`) reads `{url, password}` from the CLI's state file via `ServiceRegistration.candidates` (`service_registration.gd:19-30`: `YCODING_SERVICE_FILE` → `$XDG_STATE_HOME/ycoding/service.json` → `$HOME/.local/state/ycoding/service.json`).
7. **`http_transport.gd` is shared by both LIVE owners but never by demo.** `LiveTransport` holds one `HttpTransport` (`live_transport.gd:30,61`); `SessionApi` and `ModelCatalogApi` each receive their **own** `_side_transport()` instance (`main.gd:178,190-195`) because "a transport is a poller: sharing one would make two owners each see half the entries" (`main.gd:14-16`, `session_api.gd:12-13`).
8. **`live_transport.gd` is never entered from DEMO automatically.** No code path calls `start_live` except the user's toggle; `main.gd:243-245` returns to demo when already live. There is no fallback from a failed live connection to demo playback.
9. Location-scoping asymmetry (boundary risk): `HttpTransport.set_location` (`http_transport.gd:60`) exists and adds `x-ycoding-directory` / `x-ycoding-workspace` headers (`:307-310`), and `LiveTransport.set_location` forwards it (`live_transport.gd:83-85`), but **no production caller sets a location** (`grep -rn set_location apps/office --include='*.gd'` → definitions plus `sidebar_panel.gd:224`, a different method). The model route is location-scoped (`model.ts:10`) and its own doc says the transport "must already be configured, with the location set" (`model_catalog_api.gd:39-40`). Without a location the service falls back to `process.cwd()` (`packages/server/src/location.ts:34`), so a GUI-launched daemon and the TUI may resolve different locations — matching kit hypothesis H5. Not fixable by reading; reported as a verified source gap.

## 8. Unknowns / deferred

| Item | Status | Reason |
|---|---|---|
| Godot import, unit suite, flow check, captures | **deferred to lane C** | Constraint forbids a second Godot process (import-lock hang) |
| Real-provider request/response behaviour | **deferred** | Needs a running service + credentials; out of read-only scope (`R0-05`, `R1-06`). Kit `tracking/provider_verification.json` is `{"status": "pending_local_audit"}` |
| Whether the live service actually serves the guardrail route at the `request` segment | **unverified at runtime** | Protocol + `specs/v2/session-guardrails.md:95` agree; only a live 404/204 would prove the client side fails |
| Whether `session.active`'s `{data: {sessionID: {type:"running"}}}` is what `LiveTransport` expects | **unverified** | Office reads `/api/session/active` in tests (`tests/integration/transport_contract.gd:51`) but no production caller was found (`grep` for `Gateway.SESSION_ACTIVE` in `src` → none) |
| `apps/office/AGENTS.md` world-plan narrative | **contradiction recorded** | Guide says 40×21/6 rooms; code + test say 41×23/1 divider. Needs an owner decision, not a lane-A edit |
| Root `AGENTS.md` reconciliation | **out of scope** | Kit `templates/ROOT_AGENTS_MERGE.md` is a proposal requiring explicit user authorization |
| `packages/cli/dist/cli-darwin-arm64/bin/ycoding` contains `session.grouping` | **noted only** | Prebuilt artifact in the tree; not a source contract |

## 9. Final read-only confirmation

```
$ git status --porcelain
?? ycoding-office-repair-kit/
```

No repository file was modified. The only changed artifact is the untracked kit directory, whose `tracking/` is this lane's permitted write area.
