# Implementation task list

Generated from canonical JSON. Only actual evidence can close a task.

## R0 — Independent local audit

- [x] **R0-01 Preserve checkout and reconcile source** — done
  Acceptance: Record revision/dirty paths, instructions and current vs pinned drift; never reset/stage/commit.
  Dependencies: none.
- [x] **R0-02 Launch baseline Office and TUI** — done
  Acceptance: Capture native app and targeted TUI flows unchanged; record actual startup commands and host.
  Dependencies: R0-01.
- [x] **R0-03 Audit current ownership and wire contracts** — done
  Acceptance: Resolve desktop/service/Schema/Protocol/config/credential boundaries and exact supported operations.
  Dependencies: R0-02.
- [x] **R0-04 Inventory all settings and TUI commands** — done
  Acceptance: Generate current field/action list; classify inactive, terminal-only, missing-owner and desktop equivalents.
  Dependencies: R0-03.
- [x] **R0-05 Reproduce real-provider failure** — done
  Acceptance: Trace UI admission to runtime/provider settlement with sanitized correlation; credentials absent is a blocker not a fake success.
  Dependencies: R0-04.
- [x] **R0-06 Audit production mock reachability** — done
  Acceptance: Classify each demo/fixture/simulate occurrence; list production-reachable paths and keep legitimate isolated tests.
  Dependencies: R0-05.
- [x] **R0-07 Compare every supplied visual reference** — done
  Acceptance: Record shell, composer, settings, pixel art, scale and resize gaps with source vs screenshot evidence.
  Dependencies: R0-06.
- [x] **R0-08 Audit existing delivery chain** — done
  Acceptance: Inspect current build/export/install/release/Pages and signing support; keep naming and CLI contract.
  Dependencies: R0-07.

## R1 — Real runtime and no production demo

- [x] **R1-01 Replace production demo boot** — done
  Acceptance: Default to real connection/setup; never seed fake sessions or silently replay after failure.
  Dependencies: R0-08.
- [x] **R1-02 Repair service discovery and GUI launch environment** — done
  Acceptance: Use existing registration and safe lifecycle rules; distinguish GUI config from shell env; never print credentials.
  Dependencies: R1-01.
- [x] **R1-03 Repair provider and model selection** — done
  Acceptance: Actual selected provider/model/variant and location appear on request; stale catalog clears with actionable error.
  Dependencies: R1-02.
- [x] **R1-04 Fix durable prompt admission and retries** — done
  Acceptance: Send once, capture target, reconcile same message ID after timeout; distinguish admission from completion.
  Dependencies: R1-03.
- [x] **R1-05 Stream, stop and surface errors** — done
  Acceptance: Render provider output progressively where supported; stop is server-owned; timeout/rate-limit/auth errors remain visible.
  Dependencies: R1-04.
- [x] **R1-06 Complete one real provider smoke** — done
  Acceptance: Small prompt plus supported tool and restart/history via GUI, with real provenance and no secret output.
  Dependencies: R1-05.
- [x] **R1-07 Separate test-only transports** — done
  Acceptance: Export excludes synthetic production paths; tests may still explicitly exercise fixtures.
  Dependencies: R1-06.

## R2 — Office-first multipage shell

- [x] **R2-01 Replace rejected floating rail contract** — done
  Acceptance: Persistent left app sidebar and remaining content region; update conflicting old assertions/docs.
  Dependencies: R0-08.
- [x] **R2-02 Fix scale and layout ownership** — done
  Acceptance: Measure Control rects/min sizes; one UI scaling owner independent from world camera; no screenshot-specific offsets.
  Dependencies: R2-01.
- [x] **R2-03 Build bottom-centered multiline composer** — done
  Acceptance: Max width, Enter/Shift+Enter, IME, model/target badge, Send/Stop and focus without masking workspace.
  Dependencies: R2-02.
- [x] **R2-04 Add Office/Sessions/Statistics route owner** — done
  Acceptance: State survives navigation; background execution and attention remain available across pages.
  Dependencies: R2-03.
- [x] **R2-05 Implement contextual drawer and modal stack** — done
  Acceptance: No permanently opaque giant inspector; stable placement, Escape, focus return and dirty-state protection.
  Dependencies: R2-04.
- [x] **R2-06 Polish reusable controls/themes** — done
  Acceptance: Consistent type, spacing, disabled/hover/focus/error/loading and dark/light/system behavior.
  Dependencies: R2-05.
- [x] **R2-07 Native responsive acceptance** — done
  Acceptance: Inspect 1024x768,1280x720,1440x900,1920x1080 at 100/150/200% text; long labels and narrow states.
  Dependencies: R2-06.

## R3 — Complete working settings

- [ ] **R3-01 Implement settings navigation/search/scope** — in_progress
  Acceptance: Grouped application/workspace/connections/runtime/advanced; Global/Project/Folder/Session only where valid.
  Dependencies: R1-07, R2-07.
- [ ] **R3-02 Implement validated config owner bridge** — in_progress
  Acceptance: Reuse or add minimal scoped read/preview/write/readback with expected revision; preserve JSONC/comments and substitutions.
  Dependencies: R3-01.
- [ ] **R3-03 Wire provider credentials and custom endpoints** — not_started
  Acceptance: Use actual integration/auth lifecycle, not credential label PATCH; masked forms, OAuth errors, remove/rename and effect checks.
  Dependencies: R3-02.
- [ ] **R3-04 Wire models, variants and request overlays** — not_started
  Acceptance: Capability-driven fields; defaults vs active model; custom catalog config validates before apply.
  Dependencies: R3-03.
- [ ] **R3-05 Wire agents, autonomy and permissions** — not_started
  Acceptance: Step caps, mode, rules, guardrail counters/custom rules; preserve ceilings/hard human reviews.
  Dependencies: R3-04.
- [ ] **R3-06 Wire MCP, plugins and integration settings** — not_started
  Acceptance: Server enable/auth/timeouts/cwd/env/codemode; plugin lifecycle and hooks owner; no invented hooks root key.
  Dependencies: R3-05.
- [ ] **R3-07 Wire context, tools and efficiency** — not_started
  Acceptance: Compaction/helper/cache, vision/attachments, shell/sandbox/memory, formatter/LSP/watcher, output caps.
  Dependencies: R3-06.
- [ ] **R3-08 Wire skills, commands and references** — not_started
  Acceptance: Managed lifecycle, discovery and scoped edits; inactive instructions key is explained not enabled.
  Dependencies: R3-07.
- [ ] **R3-09 Wire appearance, input and notifications** — not_started
  Acceptance: Persist desktop values without rewriting cli.json; sounds/alerts/ntfy and input conflicts verified.
  Dependencies: R3-08.
- [ ] **R3-10 Wire advanced/service/data diagnostics** — not_started
  Acceptance: Safe effective source view, read-only env provenance, updater status, browser/computer availability and redacted diagnostics.
  Dependencies: R3-09.
- [ ] **R3-11 Exercise all settings save failures** — not_started
  Acceptance: Apply timing, restart, inherited overrides, conflict, validation, write denial, scope switch and migration.
  Dependencies: R3-10.
- [ ] **R3-12 Pass settings coverage and parity gate** — not_started
  Acceptance: No unclassified schema leaf/action; required UI/backend gaps remain open; never mark all done from generated coverage alone.
  Dependencies: R3-11.

## R4 — Fine-grained office and user walking

- [x] **R4-01 Audit and improve coherent pixel art** — done
  Acceptance: Retain usable assets, document license/provenance; near-final two-agent slice before expanding scenes.
  Dependencies: R0-08.
- [x] **R4-02 Repair navigation/anchors/Y-sort** — done
  Acceptance: No wall cutting, wrong foreground depth or stuck doors; work/visitor/meeting anchors use bounded reservations.
  Dependencies: R4-01.
- [ ] **R4-03 Refine semantic choreography** — in_progress
  Acceptance: Real delegate/work/question/report/review only; micro-transitions and independent animation queue do not block runtime.
  Dependencies: R4-02.
- [ ] **R4-04 Implement player avatar movement** — not_started
  Acceptance: WASD/arrows, normalized speed, collision, four-direction facing and safe spawn; not a model agent.
  Dependencies: R4-03.
- [ ] **R4-05 Implement focus-aware input gate** — not_started
  Acceptance: No movement from composer/IME/settings/dropdown/modal; clear held keys on focus or project change.
  Dependencies: R4-04.
- [ ] **R4-06 Implement interaction/camera controls** — not_started
  Acceptance: E opens real source; camera follow/pan/recenter; optional click-to-walk; remove conflicting camera keys.
  Dependencies: R4-05.
- [ ] **R4-07 Integrate speech/history and ambience** — not_started
  Acceptance: Source-linked concise speech; ambient actions labeled/nonverbal; no fake acknowledgments or test success.
  Dependencies: R4-06.
- [ ] **R4-08 Native fidelity and walking acceptance** — not_started
  Acceptance: Normal-speed Godot video: walk through doors, interact, type without movement, parallel agents, reduced motion and scaled UI.
  Dependencies: R4-07.

## R5 — Multiple projects and folders

- [x] **R5-01 Implement native folder picker and project resolve** — done
  Acceptance: Use actual Project/Location API; Git, non-Git, monorepo, worktree and inaccessible folder cases.
  Dependencies: R0-08.
- [x] **R5-02 Build recent/pinned project navigation** — done
  Acceptance: Compact counts/attention; rename display label only; remove never deletes data.
  Dependencies: R5-01.
- [x] **R5-03 Scope request/cache/actor identity** — done
  Acceptance: Service+location+session key; captured prompt target; no cross-project transcript/model leak.
  Dependencies: R5-02.
- [x] **R5-04 Handle asynchronous switch races** — done
  Acceptance: Late A response cannot overwrite B; switching neither cancels nor moves jobs.
  Dependencies: R5-03.
- [x] **R5-05 Persist per-project draft/view/player** — done
  Acceptance: Restore last route, session, draft, camera and safe position; no credentials in preferences.
  Dependencies: R5-04.
- [x] **R5-06 Add background attention and controls** — done
  Acceptance: From any page project A question/review/stop acts on correct family without stealing focus.
  Dependencies: R5-05.
- [x] **R5-07 Verify multi-project scenarios** — done
  Acceptance: Two concurrent real jobs, project/global overrides, symlinks/worktrees, reconnect and app restart; evidence of isolation.
  Dependencies: R5-06.

## R6 — Conversation and TUI capability parity

- [x] **R6-01 Implement complete session/history navigation** — done
  Acceptance: Canonical messages, ordered and source-linked, pagination/search policy verified; no duplicate report projections.
  Dependencies: R1-07, R2-07.
- [x] **R6-02 Implement rich transcript and tool details** — done
  Acceptance: Markdown/code/tool result/attachments where supported; escape untrusted markup and no hidden chain-of-thought fabrication.
  Dependencies: R6-01.
- [x] **R6-03 Implement agent/bubble inspector** — done
  Acceptance: Task, parent/child identity, real report and click-through; assignment keyed by session not reusable role.
  Dependencies: R6-02.
- [x] **R6-04 Implement human review/question handling** — done
  Acceptance: Equivalent once/reject/session-only where valid, hard review restrictions; human decisions not LLM dialogue.
  Dependencies: R6-03.
- [x] **R6-05 Implement files/diff/shell views** — done
  Acceptance: Use actual APIs; read-only details and supported actions; do not substitute a fake terminal.
  Dependencies: R6-04.
- [x] **R6-06 Close remaining TUI action parity gaps** — done
  Acceptance: Classify every current action with implementation evidence or explicit justified scope treatment; no silent removals.
  Dependencies: R6-05.

## R7 — Statistics, quota and budgets

- [x] **R7-01 Audit usage and request telemetry owners** — done
  Acceptance: Locate durable request/step/cost metadata and ProviderUsage contracts; no Godot DB access.
  Dependencies: R1-07, R2-07, R5-07.
- [x] **R7-02 Implement minimal aggregate read models** — done
  Acceptance: Provider/model/project/day/session filters; count physical attempts vs logical steps, helpers and children once.
  Dependencies: R7-01.
- [ ] **R7-03 Implement statistics route and charts** — in_progress
  Acceptance: Cards, activity calendar, daily chart/table, model/provider/project breakdown, source drilldown and empty states.
  Dependencies: R7-02.
- [ ] **R7-04 Implement quota windows and freshness** — blocked
  Acceptance: Reuse existing snapshots; lanes/units independent; missing != zero; unsupported providers hidden; supported error/stale states visible; refresh nonblocking.
  Dependencies: R7-03.
- [ ] **R7-05 Implement local advisory budgets** — blocked
  Acceptance: Period/scope/threshold persistence and honest warning labels, never presented as provider-side limits.
  Dependencies: R7-04.
- [ ] **R7-06 Verify limit semantics and existing enforcement** — blocked
  Acceptance: Provider quota, rate limits, context limits and local advisory budgets remain distinct. No new hard-budget enforcement is required without explicit scope approval; never expose an enforced control unless the shared backend actually enforces it.
  Dependencies: R7-05.
- [ ] **R7-07 Implement privacy-safe exports** — blocked
  Acceptance: CSV/JSON user action, formula-safe text, no secrets or auto public upload.
  Dependencies: R7-06.
- [ ] **R7-08 Verify accounting edge cases** — blocked
  Acceptance: Duplicate/retry/cancel/cache overlap/unknown price/helper and child/DST/scope hand-calculated datasets.
  Dependencies: R7-07.
- [ ] **R7-09 Verify native analytics against real session** — in_progress
  Acceptance: Record source provenance; estimate vs billed distinction; quota failure cannot break normal coding.
  Dependencies: R7-08.

## R8 — Recovery, accessibility and regression

- [ ] **R8-01 Repair snapshot/event reconciliation** — not_started
  Acceptance: Volatile SSE is not resumable history; epoch changes/missed events force canonical resync and dedupe.
  Dependencies: R3-12, R4-08, R5-07, R6-06, R7-09.
- [ ] **R8-02 Bound UI queues and memory** — not_started
  Acceptance: Rate-limited refresh, coalesced animation, paged history/analytics and bounded subscriptions for inactive projects.
  Dependencies: R8-01.
- [ ] **R8-03 Exercise negative provider/config paths** — not_started
  Acceptance: 401/403/429/timeout/malformed/error/cancel/expired credentials; no demo fallback or duplicate execution.
  Dependencies: R8-02.
- [ ] **R8-04 Exercise accessibility/input and window states** — not_started
  Acceptance: Mouse, keyboard, focus, IME, text selection, scaling, minimize/background, large data and reduced motion.
  Dependencies: R8-03.
- [ ] **R8-05 Run neighboring TUI/runtime regressions** — not_started
  Acceptance: Exact owner commands, pre-existing failures separately recorded; no blanket passing from root bun test.
  Dependencies: R8-04.
- [ ] **R8-06 Obtain native visual and flow review** — not_started
  Acceptance: Current screenshots/video and actual user acceptance against references; fix discrepancies then recapture.
  Dependencies: R8-05.

## R9 — Build and local installation

- [x] **R9-01 Integrate guarded delivery tooling** — done
  Acceptance: Preview then merge into existing owners; preserve current code and uncommitted work, no commits.
  Dependencies: R0-08.
- [x] **R9-02 Pin editor and matching templates** — done
  Acceptance: Existing 4.7.2 hashes; verify downloads before execution; no arbitrary latest engine.
  Dependencies: R9-01.
- [x] **R9-03 Run local tasks and isolated source build** — done
  Acceptance: Doctor/verify/build wrapper; fresh output; avoid mutating live project version during export.
  Dependencies: R9-02.
- [x] **R9-04 Verify archive/version/checksum contract** — done
  Acceptance: macOS universal DMG, Linux x64 tar.gz, Windows x64 ZIP plus matched CLI versions; fail missing/malformed payload.
  Dependencies: R9-03.
- [x] **R9-05 Verify Unix installer upgrade/rollback** — done
  Acceptance: Reuse --office; temporary locations, failure cleanup, compatibility and no quarantine stripping.
  Dependencies: R9-04.
- [x] **R9-06 Verify Windows portable installation** — done
  Acceptance: PowerShell checksum/allowlist/versioned per-user directory and optional shortcut; never require global bypass.
  Dependencies: R9-05.
- [ ] **R9-07 Native launch candidate matrix** — not_started
  Acceptance: macOS universal on real architectures, Linux x64, Windows x64; actual GUI attach/prompt and uninstall-data safety.
  Dependencies: R9-06.
- [ ] **R9-08 Document signing policy and add signing** — not_started
  Acceptance: Actual certificates/notary/Authenticode secrets only; signed vs unsigned accurately labelled and checked.
  Dependencies: R9-07.

## R10 — GitHub Release and website delivery

- [ ] **R10-01 Extend existing release workflow gates** — not_started
  Acceptance: Office verify/integration before export; safe inputs; trusted tags; artifact contract gate and protected publish environment.
  Dependencies: R8-06, R9-08.
- [ ] **R10-02 Test unsigned/prerelease and signing gates** — not_started
  Acceptance: No broad write tokens on PRs; exact candidate commit/evidence; publication is explicit, not a kit install side effect.
  Dependencies: R10-01.
- [ ] **R10-03 Extend existing Pages build** — not_started
  Acceptance: Keep docs/schema/install intact; /office/ from actual complete releases; no false links or hosted local-agent web app.
  Dependencies: R10-02.
- [ ] **R10-04 Wire Pages refresh after releases** — not_started
  Acceptance: Handle GITHUB_TOKEN event behavior with trusted workflow_run or explicit dispatch; never execute untrusted artifacts.
  Dependencies: R10-03.
- [ ] **R10-05 Verify staging pipeline and install downloads** — not_started
  Acceptance: GitHub job logs, valid assets, published manifest/links, platform installer checks; local tests not CI evidence.
  Dependencies: R10-04.
- [ ] **R10-06 Complete release readiness and handoff** — not_started
  Acceptance: Versioned notes, limitations/compatibility/signatures, rollback, outstanding issues and evidence; no release until required gates pass.
  Dependencies: R10-05.
