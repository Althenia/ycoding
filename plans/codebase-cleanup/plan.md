# Codebase cleanup, V2 naming removal, and performance plan

Companion files:
- `checklist.md`: step-by-step tick boxes.
- `tracking.md`: decisions, status, evidence, defects, and performance results.
- `testing.md`: acceptance criteria, checks, and new tests.

All four are working files on the `v0.9.0-wip` branch. Remove `plans/codebase-cleanup/` before merging to `main` (S11).

## Outcome

- Remove obsolete OpenCode V1 code, dead upstream code, and the upstream `V2` naming from the YCoding fork.
- Finish the TUI theme V1→V2 migration so only one theme system remains.
- Restructure the approved oversized files.
- Classify the remaining code against the upstream fork point and bring in-use, unmodified upstream modules to the repository standard.
- Measure and improve startup, latency, and memory with profiler-backed, statistically verified changes.
- Fix every defect or gap found along the way.
- Lean the test suites: keep only tests that guard a required behavior, contract, boundary, reproduced regression, or cross-component flow; rewrite flaky or implementation-coupled tests; delete the rest.
- Once the lean suites are solid, lean the production code in every package (core, tui, cli, web, ai, codemode, server, schema, protocol, client, plugin, infra/cloudflare) without changing behavior.

Durable Session data stays intact, except for the approved legacy-table drop. Wire contracts change only through the approved V2 rename and its remote protocol bump.

## Scope

In scope (approved 2026-10-02):
- Slices S2–S6: delete `packages/ui`, schema V1, dead modules, and the legacy tables, and run the unused-export sweep.
- S7: TUI theme V1 removal.
- S8: V2 naming removal across code, files, service keys, span names, schema identifiers, operation IDs, and ephemeral event types, with `RemoteProtocolVersion` going from 3 to 4.
- S9: split `project-artifact.ts` and `session.ts`.
- S1: fork-point classification (feeds SC).
- P0–Pn: performance work.
- SL: test-suite leaning across every package and `apps/web`.
- SC: production-code leaning across every package. It absorbs the upstream-module standardization formerly planned as S10.
- Defect and gap fixes found during any slice.

Out of scope:
- The Rust rewrite.
- Vendored code: `packages/core/src/cursor/provider/**` and vendored OpenTUI.
- Migration history and release notes of past versions.
- Splitting `aisdk.ts` and `browser.ts` (not approved in D6).

## Historical verified baseline (`main` `a38d1f6c`, 2026-10-02)

| Area | Fact | Evidence |
|---|---|---|
| `packages/ui` | About 36k lines and 7.6 MB of assets; only 5 sound files are used by the product (`tui/src/attention-sounds.{bun,node}.ts`, `cli/src/node/target.ts`, `cli/script/node-assets.ts`), plus one test. 15 dependencies are used only by `ui`. | import scan and greps |
| `packages/ui` wiring | Root `package.json` workspaces, `script/ycoding-workspace.ts`, `turbo.json`, `cli/test/import-boundaries.test.ts`, `script/raw-changelog.ts`, `tui/package.json`, `tui/src/audio.d.ts`, `docs/architecture.md:26,145`, `docs/repository-resources.md:103,464` | `git grep` |
| Theme-schema doc defect (G1) | The docs cite `ui/src/theme/theme.schema.json` (requires `name,id,light,dark`; no `version`). The TUI decodes `ThemeFile` (`tui/src/theme/v2/schema.ts:253-261`: `version: 2`, one of `light`/`dark`). | file reads |
| Schema V1 | `schema/src/v1/*` plus 5 entry files (about 840 lines). Used only by their own two tests and a static codemode fixture. | `git grep` |
| Dead modules | `core/src/util/{iife,array,module,retry,binary}.ts`, `core/src/v2-schema.ts`, `tui/src/component/brand-art.ts`, `tui/src/component/prompt/cwd.ts` (empty), `tui/src/feature-plugins/sidebar/lsp.tsx` (unregistered), `ai/src/providers/openrouter-responses.ts` (alias) | `git grep` |
| Legacy tables | `account`, `account_state`, `control_account`, `session_share`: no runtime reader or writer. Generated migrations come from `bun run --cwd packages/core migration`. | `git grep`; `script/migration.ts` |
| V2 identifiers | About 8,000 occurrences. Top names: `ModelV2` 1642, `themeV2` 1474, `ProviderV2` 1235, `EventV2` 902, `SessionV2` 709, `AgentV2` 604, `PermissionV2` 435, `SkillV2` 273, `PluginV2` 272, `ProjectV2` 173, plus 14 smaller namespaces. Also 190 string identifiers (Schema class IDs, tagged-error tags, `Effect.fn` span names), `@ycoding/v2/*` service keys, 172 `v2.*` Protocol operation IDs, `V2Event`/`V2Session` names, and `permission.v2.*`/`question.v2.*` ephemeral event types. | `rg` counts |
| V2 collisions | About 47 core/server files import both a core `XV2` namespace and the schema `X` namespace. Core namespaces do not re-export schema members uniformly. | `rg` |
| V2 non-targets | External names: AI SDK `ImageModelV2`/`EmbeddingModelV2`, drizzle `RqbV2`/`getRqbV2`/`allRqbV2`/`TIsRqbV2`, `SQLiteEffectRelationalQuery{,Builder}V2`, `@jerome-benoit/sap-ai-provider-v2`, model IDs `…-v2:0`, Google OAuth `/o/oauth2/v2`, Runpod `/v2`. Version numbers: theme file `version: 2`, `session-prompt-cache/v2` (cache namespace; changing it would bust provider caches), `ycoding-web-shell-v2` (service-worker cache version). Persisted data: message metadata key `remoteCompactionV2`. | `rg` |
| TUI themes | The V1 flat `theme` proxy (`context/theme.tsx:308`, `theme/current.ts`) is read 253 times in 23 files (63 keys). `specs/v2/tui-theme-migration.md` has 5 open items. All 33 built-in theme files are already version 2. | `rg`; file reads |
| Remote protocol | `RemoteProtocolVersion = 3` (`packages/remote/src/index.ts:28`); precedent bump in `205de42d` | file read, `git log -S` |
| Test volume | Test lines vs source lines: core 102,731 vs 94,153; tui 56,884 vs 64,873; ai 17,521 vs 16,484; codemode 12,669 vs 8,170. About 790 test files and about 5,600 cases (core 280 files / ~2,444 cases, tui 230 / ~1,319, ai 50 / ~574, codemode 20 / ~580, cli 49 / ~380, web 143 files). | `git ls-files`, case-pattern count |
| Test quality signals | 14 test files read production source text and assert on it (for example `tui/test/session-skill-render.test.tsx`, `server/test/guardrail.test.ts`). 107 test files use `Bun.sleep`/`setTimeout`. A full TUI run under CPU contention (2026-10-02) failed 111 cases by timeout; the same named suites pass alone. | `git grep`; run logs |
| Code volume | Non-test, non-generated source lines: core 87,484; tui 64,873; web 24,643; cloudflare 19,786; ai 16,484; cli 12,663; codemode 8,170; schema 6,684; server 4,767; protocol 4,448; client (handwritten) 3,000; plugin 1,276. Files with `legacy`/`compat`/`fallback`/`deprecated`/`backward` markers: tui 153, core 83, web 69, cloudflare 47, ai 44, client 16, cli 15, schema 10. Largest files: `core/src/project-artifact.ts` 5,226; `project-artifact/package.ts` 2,635; `session.ts` 2,324; `session/projector.ts` 1,317; `project-artifact/accounting.ts` 1,283; `aisdk.ts` 1,261; `session/compaction.ts` 1,221; `browser.ts` 1,221; `session/runner/llm.ts` 1,190. | `git ls-files` line counts, `grep -ci` |
| Startup | Installed `ycoding v0.8.8 --version`: 76.9 ± 5.1 ms (n=40, warmup 5). A compiled Bun hello-world: 3.9 ± 0.6 ms. So about 73 ms goes to module evaluation for a trivial command. This is an unprofiled candidate. | `hyperfine -N` |
| In-flight branches | `shell-durable` (+3) changes `core/src/session.ts`; `multi-remote` (+4) and `web-model-sort` (+1) are unrelated to S2–S6 but will conflict with S8 | `git diff --name-only main...<branch>` |

## S0 recheck (`main` `c9a2957a`; cleanup `092d1462`, 2026-10-03)

The local `v0.8.9` tag resolves to `1af767b6` and is an ancestor of current `main` and cleanup; release publication is evidenced separately by E11. Cleanup contains current `main`. The preceding table records its dated baseline, not today's package sizes, occurrence counts, or performance.

| Baseline row | Current `main` | Cleanup after S2–S6 | Unresolved measurement |
|---|---|---|---|
| `packages/ui` and wiring | Package, five referenced MP3s, and workspace/TUI/Turbo/script/docs references remain | Package and listed references absent; five MP3s live under TUI assets and CLI keys | Historical size and exclusive-dependency counts not recalculated |
| Theme-schema doc defect | Both cited locations refer to UI schema, while active TUI `ThemeFile` requires version 2 and a light or dark mode | Both doc references point to TUI `ThemeFile` | None for the cited defect |
| Schema V1 | Five entry modules and `src/v1/` remain | Modules and directory absent | None for listed paths |
| Dead modules | Listed paths remain | Listed paths absent | Original disuse not independently re-proven here |
| Legacy tables | Definitions present; bounded runtime search found no reader/writer | Definitions absent; generated migration drops four named tables | Migration behavior was validated by T5/E14, not rerun in this recheck |
| V2 identifiers and collisions | Current wire names still include `v2.session.get` and `permission.v2.*`; both namespace families remain | Same V2 naming still present pending S8 | Historical ~8,000/190/172 names and ~47 collisions not recounted |
| V2 non-targets | `remoteCompactionV2` and `session-prompt-cache/v2` remain | Same examples remain | Full exclusion list not exhaustively rechecked |
| TUI themes | `theme` and `themeV2`, `theme/current.ts`, and five open migration items remain | Two theme systems remain pending S7 | Historical 253 reads/23 files not recounted |
| Remote protocol | Version 3 | Version 3 pending S8 | None for the version value |
| Test volume and quality signals | Source-text-reading examples remain, but test edits make counts historical | Changed test tree; no comprehensive case/line census or contention run at this head | Historical case/line totals, 14 source-text files and 107 timer files are not current counts |
| Code volume | Named large `project-artifact.ts` and `session.ts` remain | S2–S6 removed sources; named files remain | Package totals and marker counts not recalculated |
| Startup | v0.8.8 sample is a historical comparison only | No P0 baseline at this head | M1–M8 and profile pending |
| In-flight branches | `shell-durable`, `multi-remote`, and `web-model-sort` remain separate | Not established as integrated; coordinate before S8 | Conflict paths must be rechecked at S8 |

The S0 Baseline command table in `tracking.md` is not an AC10 run at this head. Run the specified executable gates and P0 measurements before marking those checklist items complete.

## Fork point (D4)

Upstream is `https://github.com/anomalyco/opencode`, branch `v2`. **Fork point: `39fdd67123aba5afa6bd07f13b6e03660cfb4479`** (2026-07-20 22:51 −04:00, "fix: remove legacy sdk from ci builds").

Evidence:
- All 3,640 `packages/**` blobs of YCoding import commit `8e0e19c9` were compared with `v2` first-parent commits.
- The match count peaks at 2,270 on `43c08387`, `fc7e4cf9`, `44b6938b`, and `39fdd671`.
- It drops to 2,262 at the next commit, `065b108b`.
- The first pass on 66 unbranded blobs agreed (64/66).
- Upstream at this commit contains `packages/ui` and `packages/storybook`.

S1 recreates the comparison source outside the repository with `git clone --bare --filter=blob:none https://github.com/anomalyco/opencode.git <tmp>/opencode.git`.

## Decisions

D1–D15 were approved on 2026-10-02. D16–D40 (2026-10-02/03) and every outcome live in `tracking.md` § Decisions:
- D1: all deletions.
- D2: drop the tables.
- D3: one-off knip.
- D5: point the docs at `ThemeFile`.
- D6: split `project-artifact.ts` now and `session.ts` after `shell-durable` merges.
- D7: remove the V2 naming.
- D8: commit per slice.
- D9: rename the wire strings and bump `RemoteProtocolVersion` to 4.
- D10: finish the theme migration, then rename.
- D11: lean the test suites (SL).
- D12: release v0.8.9 before any cleanup slice.
- D13: lean the production code after SL (SC).
- D14: a one-off `bunx jscpd` duplication scan, on the same no-repository-change terms as D3.
- D15: TUI tests run targeted only, never the full suite.

## Slices (dependency order)

Prerequisite: v0.8.9 (the skill-invocation fix on branch `skill-activation`) is released first. S0 starts from the `main` commit tagged `v0.8.9`, and every "Verified current state" fact above is rechecked at S0.

| Slice | Depends on | Target | Exit |
|---|---|---|---|
| S0 Baseline | — | worktree `.worktrees/codebase-cleanup`, branch `codebase-cleanup`; functional baseline; P0 performance baseline | baselines recorded |
| S1 Classification | S0 | local `classify.ts`, `classification.md` | AC9 |
| S2 Remove `packages/ui` | S0 | see `checklist.md` | AC1–AC3 |
| S3 Remove schema V1 | S0 | schema V1 files, `ai/STATUS.md` | AC4 |
| S4 Remove dead modules | S0 | listed files, `core/test/shared-schema.test.ts` | AC5 |
| S5 Drop legacy tables | S0 | account/share modules, generated migration, T5 | AC6 |
| S6 Unused exports | S2–S5 | knip triage | AC7 |
| SL Test-suite leaning | S6 | every package test tree and `apps/web` tests; `AGENTS.md` testing rules | AC15 |
| S7 TUI theme V1 removal | SL | DESIGN.md rules first, then 23 TUI files, `context/theme.tsx`, `theme/current.ts`, `specs/v2/tui-theme-migration.md` | AC11 |
| SC Code leaning | S7; S1 | one package per sub-slice: SC-core, SC-tui, SC-cli, SC-web, SC-ai, SC-codemode, SC-server, SC-schema/protocol/client/plugin, SC-cloudflare | AC16 |
| S8 V2 naming removal + protocol 4 | SC; `shell-durable`, `multi-remote`, `web-model-sort` merged or rebased with the S8 codemod | repository-wide | AC12, AC13 |
| S9 Restructure | S8; `shell-durable` merged | `core/src/project-artifact.ts`, `core/src/session.ts` | AC8 |
| P0 Performance baseline | S0, then again after S9 | harness `plans/codebase-cleanup/perf/*` | baseline table filled |
| P1…Pn Optimizations | P0 rerun after S9 | one bottleneck each | AC14 per item |
| S11 Close-out | all | — | AC10 |

S2–S5 touch disjoint files and may run in parallel with one writer each. SL runs before S7–S9 so the large renames and restructures carry only the retained tests, while every retained behavior keeps its guard during those refactors. SC runs after S7 (so it never leans code S7 deletes) and before S8 and S9 (so the rename and the file splits act on less code). SC sub-slices run one package at a time, with one writer each. S7 and S8 are serialized and each affects nearly every TUI file. Performance optimizations run after the restructure so each one measures final code and never conflicts with mechanical renames.

## V2 removal design (S8)

- **Core namespaces** drop the suffix: `SessionV2` → `Session`, and likewise for each namespace. A core/server file that also needs schema members uses only the core namespace. Any missing member is re-exported from the core module (`export const X = Schema.X` / `export { X } from "@ycoding-ai/schema/<m>"`, matching `core/src/session/schema.ts`), and an identity row is added to `core/test/shared-schema.test.ts`. No import aliases.
- **String identifiers:**
  - Schema class and brand identifiers: `ConfigV2.*` → `Config.*`, `PermissionV2.ID` → `Permission.ID`.
  - Tagged-error tags: `PermissionV2.NotFoundError` → `Permission.NotFoundError`.
  - `Effect.fn` span names: `V2Session.create` → `Session.create`.
  - Service keys: `@ycoding/v2/X` → `@ycoding/X`; `@ycoding/GitV2` → `@ycoding/Git`.
  - Change every identifier and all its `catchTag` users together.
- **Protocol:**
  - The 172 operation IDs `v2.<group>.<op>` become `<group>.<op>`.
  - `V2Event` → `ServerEvent`; `V2Event.server.connected` → `ServerEvent.server.connected`.
  - Remove the dead `parts[0] === "v2"` branch in `httpapi-codegen/src/index.ts:763`.
  - Regenerate the clients and OpenAPI with the owning command; never hand-edit generated output.
- **Ephemeral events:** `permission.v2.{asked,replied}` → `permission.{asked,replied}`; `question.v2.{asked,replied,rejected}` → `question.{…}`. Update every consumer: web store, CLI non-interactive runner, TUI, and tests.
- **Remote protocol:** `RemoteProtocolVersion` 3 → 4. Follow the `205de42d` precedent:
  - `infra/cloudflare/src/index.ts` route docs.
  - `infra/cloudflare/test/router.test.ts`: v3 is now an old version and is rejected.
  - `docs/remote-deployment.md`.
  - `packages/remote/CONTRACT.md` mapping table.
  - The real-flow integration script.
  - Old backends get the existing explicit route rejection until they update.
- **TUI** (after S7):
  - `themeV2`/`valuesV2`/`contextsV2`/`setThemeV2` → `theme`/`values`/`contexts`/`setTheme`.
  - Merge `theme/v2/*` into `theme/`.
  - `mini/stream-v2.{transport,subagent,fragment}.ts` → `mini/stream.{transport,subagent,fragment}.ts`.
  - Remove the aliased re-export `ThemeFile as ThemeSource` (`theme/index.ts:10`).
- **Files and docs:**
  - `specs/v2/*` → `specs/` (no name collisions: `project.md`, `storage/`, `tui-package.md` are distinct). Update every `specs/v2` reference in `AGENTS.md` files and `docs`.
  - Rename the codemode fixture `ycoding-v2-openapi.json` to `ycoding-openapi.json` with unchanged content.
  - Regenerate `.okf` and `docs/okf` through their owning tool.
- **Codemod:** a local, rerunnable script (`plans/codebase-cleanup/v2-codemod.ts`). It applies an explicit identifier and string map with word boundaries, excludes the non-targets and vendored paths listed above, then runs typecheck. In-flight branches run the same script before rebasing.

## Theme migration design (S7)

1. Read root `DESIGN.md` and `packages/tui/DESIGN.md`.
2. Add token rules for the open spec items: paired badge/label foreground and background; strong warning/error backgrounds with readable foregrounds; a `selectedForeground` replacement (complete pairs or a contrast helper for transparent themes); the thinking-opacity decision; syntax styles generated from V2 tokens. Lint them with `python3 ~/.agents/skills/daedalus/scripts/design_md.py lint <file> --strict`.
3. Add a characterization test that records, for all 33 built-in themes in both modes, the resolved color of each of the 63 V1 keys. The migrated V2 token must resolve to the same color unless a new DESIGN.md rule states the change.
4. Migrate the 253 reads, delete the V1 proxy, `Theme`, `generateSyntax` V1 inputs, and `selectedForeground`, and delete `specs/v2/tui-theme-migration.md` once every item is done.

## Performance workstream (P)

- **Harness** (local, under `plans/codebase-cleanup/perf/`). Each metric gets at least 30 samples after warmup, with the median, p95, and RSS recorded.
  - M1: CLI cold start (`--version`, `--help`).
  - M2: managed server boot to ready on an isolated data directory.
  - M3: TUI first frame through an actual interactive render boundary; `smoke:tui` checks packaged help and hidden-server readiness, not a first frame.
  - M4: prompt admission to first provider request, and to step completion, against the `runtime-smoke` local fake provider.
  - M5: transcript read latency and TUI resident render for a 2,000-message Session.
  - M6: idle and post-load server RSS, plus a 10-minute soak.
  - M7: event-feed fan-out latency.
  - M8: binary size (informational).
- **Statistics:** Mann-Whitney U with p < 0.05, computed by a local script over `hyperfine --export-json` or harness samples.
- **Profiling:**
  - `bun --cpu-prof` on source entrypoints (listed by Bun 1.4.2). Bun lists no heap-profile flag, so memory is measured with `process.memoryUsage()` sampling and RSS.
  - M1 starts from the import graph of the `--version` path.
- **Per optimization (P1…Pn):**
  - One profiled bottleneck, one change, and the same harness before and after.
  - Pressure categories chosen by risk.
  - Keep a change only if it is significant and at least 10% better, or if the user approves the tradeoff. Otherwise revert only that change and record the negative result.
- **Constraints:**
  - Never change the model-visible prompt prefix or cache placement for speed.
  - Never weaken durability, ordering, or error handling.
  - Never add a dependency without approval.

## Test-suite leaning design (SL)

Keep a test only if it guards at least one of:
- a public contract (Schema, Protocol, durable events, generated client, remote envelopes, CLI flags);
- a documented runtime rule (Session, autonomy, guardrails, permissions, provider cache and usage, compaction, migrations);
- a trust boundary (authentication, ownership, permissions, path containment, secret redaction);
- a reproduced regression;
- a cross-component flow or rendered TUI/web behavior;
- a design-drift gate (`design-md` tests).

Each behavior is tested once, at the lowest layer that can detect it, plus one flow test where layers interact.

Remove or rewrite:
- **Delete:**
  - tests that assert on production source text;
  - tests that only confirm a mock was called;
  - tests of private helpers already covered through their public caller;
  - near-duplicate permutations of one rule (replace them with one table-driven case);
  - snapshots of current output with no stated requirement;
  - tests of removed or dead features;
  - coverage-only cases.
- **Rewrite:** sleep- or wall-clock-dependent tests that fail under load. Use deterministic awaits, `TestClock`, or event completion instead of sleeps.

Method, per package:
1. Inventory every case: file, behavior guarded, layer, wall time.
2. Classify each case as `keep`, `merge`, `rewrite`, or `delete`, with a reason.
3. Map each retained behavior to its surviving assertion.
4. Apply the changes.
5. Prove the retained suite still catches what matters with mutation probes. For each removed group, temporarily mutate the guarded production behavior and observe a failure in the remaining tests. Revert the probe.

There are no test-count targets. Report before/after files, cases, lines, isolated wall time, and flake results (three isolated runs plus one run under parallel load).

Always kept:
- release-workflow suites;
- `design-md` drift tests;
- Schema/Protocol/Client contract suites;
- migration tests;
- remote ownership and relay-security tests;
- provider cache/usage normalization tests.

Update the `AGENTS.md` "Testing and completion evidence" section with the lean-testing rule in the same change.

## Code leaning design (SC)

Goal: less code, fewer states, and fewer layers, with identical behavior. The lean suites from SL are the safety net. They must stay green with **no assertion edits** unless a slice intentionally changes behavior with an approved, tested reason.

Lean targets, in priority order:
1. **Compatibility and dead paths:** legacy branches, fallbacks, shims, aliases, dual paths, and deprecation layers (`AGENTS.md` forbids them without an explicit request); unreachable branches; invariant configuration; unused options; commented-out code.
2. **Duplication:** logic repeated across modules or packages. Collapse it into one owner in the correct package for the dependency direction (Schema → Core/Protocol → Server → Client → CLI/TUI; web never imports Core or Server).
3. **Over-abstraction:** one-implementation interfaces, one-product factories, pass-through wrappers, single-use helpers that do not name a real concept, and layers that only forward.
4. **Hand-rolled utilities:** replace them with standard, Bun, Effect, or already-installed library APIs. Add no new dependencies.
5. **Control flow and state:** reduce state machines and flags, and replace reassignment and `else` chains with the `AGENTS.md` style (early returns, `const`, inference, no destructuring, no aliased imports).
6. **Upstream-unchanged modules** (from S1): bring the in-use ones to the repository standard. This absorbs the former S10.

Per package:
1. Map the module graph and public surface (package `exports`, plugin API, Protocol).
2. Rank modules by size × churn × S1 class.
3. Lean the top modules first, in reviewable batches.
4. After each batch, run the package typecheck, `lint` (0 errors, no new warnings in touched files), `lint:effect-patterns`, the package's lean suite, and any consumers' suites.
5. Record before/after lines, file count, and M1 startup plus binary size (SC-cli/SC-tui/SC-core).

Constraints:
- No public-contract, durable-event, stored-data, or dependency change without approval.
- Keep provider cache prefixes and usage semantics byte-stable (`AGENTS.md` provider rules).
- No speculative rewrites.
- A behavior bug found while leaning becomes a Defects row with a reproduction test.

## Defects and gaps

Rules (user directive, 2026-10-02):
- Every defect or gap found during any slice gets a `tracking.md` § Defects row with evidence.
- Each fix gets a failing reproduction at the right boundary (unit, integration, or render), then a root-cause fix and the neighboring suites.
- Fixes that change a public contract, stored data, or dependencies need approval first.

Known items:
- G1: the theme-schema doc (S2).
- G2: stale V1 path in `ai/STATUS.md` (S3).
- G3: unregistered `sidebar/lsp.tsx` (S4).
- G4: `SessionRestart.resumeSuspendedSessions` has no product caller; only tests call it (S6 triage).
- G5: a stale repository memory note on restart continuation (close-out).
- G6: the dead codegen `v2` branch (S8).
- G7: the aliased `ThemeSource` re-export (S8).
- G8: the TUI did not project `session.skill.activated` or `session.skill.deactivated` live. It is fixed on branch `skill-activation` for v0.8.9.
- G9: invoked skills carried only the raw `SKILL.md` body and were recorded before the prompt. Both are fixed on branch `skill-activation` for v0.8.9.
- G10: timing-dependent tests fail under CPU contention (SL).
- G11: 9 stale or regressed cases in `tui/test/composer-live-fixes.test.tsx` on `main` (SL).

## Contracts, data, rollout

- **Removed public subpaths:** `@ycoding-ai/schema/{session-v1,permission-v1,question-v1,filesystem-v1,legacy-event,v1/*}`, `@ycoding-ai/ai/providers/openrouter-responses`, `@ycoding-ai/core/{v2-schema,account}`, and `@ycoding-ai/ui/*`. Add no aliases.
- **Wire changes (S8):**
  - Protocol operation IDs: this affects `ycoding api <operationId>` and OpenAPI.
  - Ephemeral event types.
  - Schema identifiers, which become OpenAPI component names.
  - `RemoteProtocolVersion` 4.
  - The TUI and web are rebuilt from the same commit. Old local backends are rejected by the relay until they update.
- **Data:** only S5 changes stored data. Rollback means restoring a database backup.
- **Release:** the next `docs/releases/v<version>.md` lists the removed subpaths, the table drop, the operation-ID rename, the remote protocol bump (old backends must update to use the web), and measured performance changes.
- **Deploy:** the Cloudflare relay deploys only through the release workflow. Nothing in this plan deploys directly.

## Documentation updates (same change as the code)

- `docs/architecture.md` (S2, S8).
- `docs/repository-resources.md` (S2, S8).
- `docs/runtime.md` and `docs/configuration.md` where V2 names, operation IDs, or event types appear (S8).
- `docs/remote-deployment.md` and `packages/remote/CONTRACT.md` (S8).
- `packages/ai/STATUS.md` (S3).
- `AGENTS.md` and package `AGENTS.md` files for the `specs/v2` → `specs` paths (S8).
- `packages/tui/DESIGN.md` (S7).
