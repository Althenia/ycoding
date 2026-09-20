# Session log

## 2026-09-16 — kit preparation

Inputs: original audit/repair/completion request and six supplied images. Tool: Secure files discovery and list_roots retry. Result: conversation-level FORBIDDEN; no local files read or modified. Public research: official Godot Control/Container/scaling/SubViewport/HTTPClient documentation only. Output: standalone repair/completion kit and local audit/validation utilities. Application test/provider/native screenshot evidence: none. Refer to PACK_VALIDATION for tests of the kit itself.

Append local sessions with actual revision/dirty state, task IDs, changed files, exact commands/outcomes, native evidence, failures/blockers and next handoff. Do not replace this history with an optimistic completion summary.

## 2026-09-16 — expanded source-based kit

Read the pinned public GitHub source through the connected GitHub tool, including current Office startup/layout and build/install/Release/Pages owners. Read configuration/usage/project contracts and Tokscale README; official Godot input/export and GitHub Pages/token docs were also inspected. Added multi-project, player, full-settings coverage, multipage analytics/quota and guarded delivery utilities. No local code or native/provider run. 42 utility tests passed; see PACK_VALIDATION.

## 2026-09-16 — local session 1: R0 audit (orchestrated lanes)

Source revision `a4bb99e` (`main`). Dirty state: untracked `ycoding-office-repair-kit/` only;
`git diff` and `git diff --cached` both empty, no Godot process left running. Nothing was staged,
committed, pushed, tagged or published.

Environment verified first: the checkout is ONE commit past the kit's pinned revision `77ef431`
(that commit is release notes only, with zero `apps/office` changes), so no kit application task was
superseded and no rebuild was needed. The kit's guarded baseline blobs equal the live files exactly.

### Independently verified defects (orchestrator, read directly from live code)

- **Production demo boot.** `app/main.gd` `_ready()` calls `_start_demo()` unconditionally, loading
  `res://fixtures/oauth-workplace.jsonl` and setting `MODE_DEMO`. An ordinary launch fabricates an
  occupied office.
- **Synthetic model catalogue overwrites LIVE.** `_model_catalog()` returns
  `ModelCatalog.demo_catalog()` with no mode check while `_refresh_ui()` calls it on EVERY refresh,
  so a LIVE session whose model fetch failed gets four plausible synthetic models instead of an empty
  list plus the service's refusal.
- **Composer submit parity.** The TUI binds `input_submit: return` and `input_newline:
  shift+return,...` (`packages/tui/src/config/keybind.ts:172-173`); the office composer submits only on
  Ctrl/Meta+Enter, so plain Enter does nothing and Shift+Enter is unhandled.
- **Prompt identity is non-deterministic.** `_prompt_message_id` derives the id from
  `Time.get_unix_time_from_system()`, so the runtime's exact-retry reconciliation is unreachable.
- **Five tests never run.** `run_tests.gd` calls only `suite.run(self)`; four `test_shell_layout.gd`
  tests and `test_layout.gd:137 test_lobby_band_holds_no_anchors` are defined but not invoked, so the
  lobby invariant that R2 inverts is silently unenforced.
- **World plan drifted from its guide.** `apps/office/AGENTS.md` documents 40x21 with six rooms and
  dividers at cols 12 and 26; the live plan is 41x23 with ONE divider at col 26 (four rooms).
- **Dangling authority citation.** `apps/office/AGENTS.md:9` and `core/wire.gd:1` cite
  `contracts/wire-audit.json`, which exists nowhere. Recoverable because `wire.gd:3-4` names the real
  Schema owners.
- **Chrome cluster illegible and clipped.** Five controls share `TOGGLES_W := 76`, and every unhidden
  toggle renders the literal text "Hide", so two buttons are indistinguishable in the render.
- **Capture tools coupled to the demo boot.** Five `tools/*.gd` drive `_scene.demo.advance(...)` and
  would render an empty office once R1-01 lands; they must opt in explicitly.
- **Settings surface absent.** 3 of 236 kit catalog rows are wired (motion, palette mode, text
  scale); no Settings page, routing or config bridge exists in `apps/office`.
- **No config HTTP group exists.** The core Config service is read-only, so kit task R3-02 requires an
  additive protocol group plus a regeneration step.

### Baseline evidence (all four tiers)

`tools/verify.sh` PASSED (6234 assertions, 18 flow checks, 0 engine errors); `verify-integration.sh`
PASSED (INTEG 21/21, LIVE-ATTACH 26/26); the TUI artifact smoke passed; and native captures were taken
at 1280x720 for the demo boot, a missing registration and an unreachable service.

The three native captures are the most decisive artifacts. An **unreachable attach** renders fully
honestly (LIVE badge, specific loopback address, "No sessions observed yet.", "No agents working.",
zero actors). A **missing registration** renders the correct error text
("No local service registration found. Start the server first.") but leaves a fully populated synthetic
office behind it, which is the exact failure the kit's "never translate disconnection into successful
completion" rule forbids.

A **real provider round-trip** completed through the client's own transport modules: the local service
created `ses_r0_lane_c` (HTTP 200), one prompt was admitted with an empty refusal reason, and a
terminal `session.step.ended` arrived with `finish="stop"`, cost 0.0112332 and 16861 input tokens on
`~deepseek/deepseek-pro-latest` via openrouter. No credential values are present in the retained log
(0 matches for api_key/bearer/sk-/token=/password).

### Lanes and disruption

Six lanes ran. A provider-side disruption failed four of them near the end; the notes for lanes D, E and
B and the evidence for C had already landed, while A, C's methodology note and F were lost. C's logs
survived and were recovered by the orchestrator, which is how the real-provider result above is
recorded. Recovered lanes were re-dispatched with write-first, flush-per-section instructions and the
already-established facts supplied so no work was repeated.

## 2026-09-16 — local session 1, continued: R0 closed, R1 in flight

R0 is COMPLETE (8/8). Evidence reached 39 records. Two repairs landed with RED->GREEN proof.

**Guardrail route repair (R0-03).** The office built `/api/session/:id/guardrail/:req/reply` while the live route
is `/api/session/:sessionID/guardrail/request/:requestID/reply`, so answering a human guardrail review — the
safety path — could never succeed. It failed silently AND flipped the feed to CONNECTION_DISCONNECTED,
mislabelling a route error as a connection drop. Fixed, with a new test that demonstrably catches it (RED 1
failure -> GREEN 6276). The reason it survived: `test_gateway_contract.gd` pinned session/snapshot/message/
prompt/interrupt/subagent/log/envelope/delivery/auth but asserted NO attention route. Also fixed: all three
dangling `contracts/wire-audit.json` citations (AGENTS.md:9, core/wire.gd:1, fixture_translator.gd:8) re-pointed
at the live Schema/Protocol owners.

**Production boot repair (R1-01/R1-02).** `_ready()` now calls `_boot_live()` instead of `_start_demo()`, and the
demo path has exactly one call site — the explicit user action. `_model_catalog()` is mode-gated, closing the
second defect where a failed LIVE model fetch was silently replaced by four plausible synthetic models.
Independently re-run by the orchestrator: **6333 passed, 0 failed** against a 6234 baseline. Three separate RED
runs prove the tests detect each defect, including one in the lane's own first fix (DEMO->LIVE left synthetic
actors behind, fixed via `_reset_projection`).

Held at in_progress deliberately: R1-01/R1-02 require `native_runtime` evidence and no capture of the NEW boot
exists yet. Tests and source inspection are not a substitute, so a capture lane was dispatched rather than the
tasks being claimed done.

**Accounting defects that must precede any Statistics page (R7-01).** Six ways the runtime can double count or
silently drop, independently re-verified by the orchestrator for two of them: `helpers` is a subset of `logical`
(so summing double counts), and `cost` is all-or-nothing — ONE unpriced record makes the whole summary cost
`undefined`, so a naive "known spend" card would read unreported whenever any attempt lacks pricing. A 30-day
cleanup destroys the only per-day/per-model detail, and `session.cost` defaults to 0 so "free" and "unpriced" are
indistinguishable. Exactly five provider adapters exist; no adapter for any other provider.

**Lanes that failed and what was recovered.** Provider disruption killed five lanes. Their flushed notes and logs
survived and were recovered rather than re-run: the real-provider round trip, the visual gap table, the delivery
chain audit, the ownership/wire map and the settings reachability table all came from recovered artifacts. Two
lanes were re-dispatched with write-first, flush-per-section instructions and the already-established facts
supplied.

### Verification lesson: two lane claims were corrected by re-running them

**A "before/after" capture pair was byte-identical.** Lane K reported fixed and baseline captures that had the
same SHA-256, which is not evidence of a change. Its note explained why (the helper deliberately preserves
captured output) and revealed the real problem: it verified against a SIMULATED post-G tree because lane G had
not landed yet. Rather than accept stale evidence, the orchestrator re-ran the capture against the real post-G
tree; that run printed `actors=1 interactions=0 mode=DEMO` and wrote a distinct artifact, which is the evidence
recorded for R1-07.

**A first evidence scan produced a false alarm.** An initial narrow scan suggested 13 of the office's wire
constants were not live names, including `session.file-change.recorded`. Widening the scan to every string
literal in `packages/schema` and `packages/protocol` showed **40 of 40 constants are exact**, and the apparent
misses were enum VALUES (launched/started/progressed/completed/failed/cancelled/lost, idle/busy/retry) rather
than event type names. The correction is recorded, because the wrong version would have sent a lane hunting
invented API surface that does not exist.

**Documentation lagged the boot change and was repaired.** `docs/runtime.md` said LIVE is entered only on an
explicit request — the opposite of the new contract. `docs/configuration.md` needed "In LIVE it reads" to become
"On start it reads". `apps/office/AGENTS.md` now states which mode a normal launch enters while preserving
"Never auto-switch DEMO to LIVE" verbatim. `README.md:43` still claimed the client "works offline with synthetic
playback otherwise" and was corrected. `docs/releases/v0.2.5.md:8` was deliberately NOT changed: it is a
historical record of a shipped release, and editing it would falsify the record rather than fix a live claim.

### The question-attention mismatch is a design decision, not a field fix

There are TWO question systems. Orchestration questions carry `data?: AnswerData` where
`AnswerData = Schema.Json` — UNSTRUCTURED JSON. V2 questions carry typed
`questions[].options[].label` and live in a DIFFERENT ID SPACE (`que_` versus `qst_`). The UI reads the typed
option list out of the untyped orchestration event, so it can neither render permitted answers nor correlate the
two systems by id. Adopting the v2 question tool as the canonical desktop attention surface is recommended and
sequenced into R6, because it changes what a human under review is shown and must be reconciled with the TUI.
