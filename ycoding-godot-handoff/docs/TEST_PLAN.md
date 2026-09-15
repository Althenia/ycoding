# Verification plan

A green unit suite is not visual acceptance. A deterministic replay is not a live-provider integration. An exported file is not a successful native launch. Keep these evidence types separate.

## Wire names

The five presentation labels used by the shipped fixtures (`connection.changed`, `session.observed`, `activity.changed`, `interaction.created`, `session.settled`) are **client-internal**. None exists on the YCoding wire. The real vocabulary is recorded in [`contracts/wire-audit.json`](../contracts/wire-audit.json) under `actual_event_vocabulary`. `DemoTransport` translates fixtures into the real names before they reach `OfficeStore`, so demo and live share one reducer. A fixture name appearing directly in a reducer switch is a defect.

## Test levels

**Unit:** real parser, mapper, reducer, identity and director code with controlled transport/clock/navigation boundaries. **Integration:** real Godot HTTP/SSE code against a controlled local fixture server or approved isolated YCoding instance. **Live:** authorized ordinary prompt against the actual backend/provider, with sanitized IDs and evidence. **Visual:** actual Godot scene capture and user review. **Export:** native packaged app launched without an editor.

Start with a small GDScript test runner or a justified version-pinned addon. The runner must return nonzero on failure and run production modules rather than rewriting the implementation in tests. Backend changes also need owning-package regression/typecheck coverage.

## Test matrix

| ID | Level | Scenario | Required assertion |
|---|---|---|---|
| TEST-001 | Audit | Correct checkout and instructions | Root/HEAD/status recorded; existing edits preserved; no Git writes |
| TEST-002 | Audit | Native-surface policy | Explicit permitted Godot surface; existing runtime/JS boundaries retained |
| TEST-003 | Build | Godot import and main scene | No parser/resource errors; actual scene starts |
| TEST-004 | Unit | Fixture contract | Valid events accepted; invalid/missing fields rejected with actionable errors |
| TEST-005 | Unit | Mode isolation | DEMO cannot send live mutations; switching transport invalidates pending responses |
| TEST-006 | Unit | Scope/actor identity | Same agent definition in two sessions yields distinct assignments |
| TEST-007 | Unit | SSE UTF-8 segmentation | Every split around a multibyte character preserves correct text |
| TEST-008 | Unit | SSE framing | CR/LF/CRLF, comments, multiline data, IDs, retry, unknown fields and EOF handled correctly |
| TEST-009 | Integration | SSE failure/overflow/oversize | Bounded memory; visible stale/resync state; no silent lost-state claim |
| TEST-010 | Integration | Snapshot/event race | Events before/during/after fetch cannot restore obsolete status; stale generations discarded |
| TEST-011 | Integration | Service epoch change | Incomparable watermarks invalidated; family/active state reloaded; no old bubbles |
| TEST-012 | Integration | Child pagination | All relevant pages loaded; context filter maintained; no cross-workspace leakage |
| TEST-013 | Integration | Prompt parity | Ordinary text/DTO/delivery/settings preserved; no roleplay injection or automatic launch tool |
| TEST-014 | Integration | Double submit and ambiguous timeout | Stable supported retry identity/reconciliation; no unintended extra prompt execution |
| TEST-015 | Integration | Interrupt/idle/unknown session | Correct backend contract; immediate UI truth; obsolete animations cancelled |
| TEST-016 | Integration | Approval/question/guardrail | Valid current options only; stale reply handled; no avatar auto-approval |
| TEST-017 | Unit | Semantic mapping | Verified read/edit/test categories used; unknown tool and idle status not overclaimed |
| TEST-037 | Scen | Work-state legibility | Reading, typing, waiting and blocked/attention states are distinguishable without relying on color alone (F-08): each state renders a distinct text label in addition to any indicator |
| TEST-018 | Unit | Conversation provenance | Real source identity per item; delegated prompt not duplicated by projection; exact negation preserved |
| TEST-019 | Integration | History reopen and child navigation | Canonical messages reload after desktop restart; missing sources explained |
| TEST-020 | Unit | Queue bound and event bursts | State immediate; decorative queue bounded/coalesced; old visits expire without deleting history |
| TEST-021 | Unit | Interrupt during animation | Tokens invalidated; late tween callback cannot revive stale status |
| TEST-022 | Unit/scene | Navigation correctness | All work/visitor anchors reachable through doors; no corner cutting/wall crossing |
| TEST-023 | Unit/scene | Reservation lifecycle | Shared destination contention; cancel/removal/timeout releases occupancy |
| TEST-024 | Unit/scene | Unreachable or moving target | Cosmetic fallback at valid position; runtime and approvals never blocked |
| TEST-025 | Visual | Depth and sprite alignment | Front/back furniture overlap correct; feet/pivots stable; no desk-sitting misalignment |
| TEST-026 | Visual | Micro-sequence quality | Stand/turn/walk/talk/sit/type coherent in actual two-actor clip |
| TEST-027 | Visual | Pixel scale/camera/UI | 720p/1080p, odd sizes and high DPI remain readable/sharp; no jitter/clipping |
| TEST-028 | Unit/visual | Ambient preemption | Idle action cancelled promptly on real work; no generated ambient speech/cost |
| TEST-029 | UI | Selection/bubbles/history | Click/focus/source jump correct; bubbles clamped and overlap controlled |
| TEST-030 | UI | Accessibility and themes | Keyboard paths, visible focus, reduced motion, text scaling and light/dark panels work |
| TEST-031 | UI/security | Long/untrusted content | Unicode/long reports wrap; markup escaped; no auto-executed URLs/commands; secrets excluded |
| TEST-032 | Integration | Workspace switch during requests | Late response cannot change new workspace or post to wrong session; draft preserved |
| TEST-033 | Performance | Four-actor baseline and 12-actor burst | Reference-machine frame/update targets measured; no unbounded cosmetic queue |
| TEST-034 | Soak | 30-minute mixed activity | Resource use bounded; transcripts evict/reload; minimize/restore and repeated reconnect stay responsive |
| TEST-035 | Export | Native launch/lifecycle | App runs without editor; closes without killing shared service; auth/config errors clear |
| TEST-036 | Release | License/evidence/regression | Asset permissions recorded; no secrets bundled; relevant backend tests and real capture included |

## Evidence requirements

For each executed check record: command or manual steps, working directory, local SHA/dirty-diff identifier, Godot version, OS/hardware, fixture revision/mode, expected result, actual result, exit code and evidence path. Mark unavailable environments `not_run`, never pass. Distinguish pre-existing failures from introduced regressions using M0 baseline evidence.

Unit timing is deterministic. Integration tests inject split chunks, malformed events and disconnects at the boundary while exercising the actual client. Visual tests use the exact product rendering path. End-to-end live tests need not reproduce the OAuth fixture's wording or agent count; assert that every visible claim has a corresponding actual runtime source.

## Critical negative assertions

No generated speech in LIVE without a source. No “tests passed” derived merely from generic shell success. No historical messages replayed as new social scenes on reconnect. No forced four-worker topology. No live mutation in DEMO. No late request affecting a new selection. No blocked game movement delaying a prompt/approval. No task marked done from an unrun test.

## Commands

See [LOCAL_SETUP.md](LOCAL_SETUP.md) for planned Godot and backend commands. Discover local package commands and test runner paths in M0/M1; do not present the example paths as already implemented. The handoff utility tests in [PACK_VALIDATION.md](../PACK_VALIDATION.md) validate this package only, not TEST-003 through TEST-036 of the future app.
