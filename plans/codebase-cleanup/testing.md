# Codebase cleanup — testing plan

Baseline: the `main` commit tagged `v0.8.9`. Rerun S0 if `main` moves before work starts.

## Rules

- Run only focused, affected checks; never the root `bun test` script (it fails intentionally).
- TUI (D15): never run the full TUI suite. Run the TUI tests that cover the touched files (`rg -l` on the changed symbols under `packages/tui/test`), plus the release-leg TUI suites: `test/session-transcript-live-fixes.test.tsx test/cli/tui/permission-interaction.test.tsx test/cli/tui/permission.test.ts test/util/permission.test.ts test/branding.test.ts`.
- Run heavy suites one at a time. Under parallel load the TUI suite produced 111 timeout failures that pass when run alone (G10).
- Record each command, exit status, and pass/fail counts in `tracking.md` § Evidence.
- A check that already failed in the S0 baseline is pre-existing. It is never fixed silently or counted as passing; it becomes a Defects row.
- Memory caps: package suites and typecheck `memory_limit_mb: 8192`; the whole CLI package `14336`; the Node build integration case alone with a higher cap.

## Acceptance criteria → checks

| AC | Requirement | Check (exact command) | Pass condition |
|---|---|---|---|
| AC1 | The TUI plays the five attention sounds from TUI-owned assets in the Bun binary and the Node build | `bun test --cwd packages/tui test/attention-sounds.test.ts` (T1); `bun run build:tui`; `bun run smoke:tui`; `bun test --cwd packages/cli test-integration/node-build.test.ts` (T2, macOS arm64) | T1 is green before and after; builds exit 0; the Node build contains all five sound keys |
| AC2 | `packages/ui` is gone; package lists, Turbo, and lockfile agree | `bun run check:ycoding-workspace`; `bun install --frozen-lockfile`; `bun test --cwd packages/cli test/import-boundaries.test.ts`; `bun test --cwd script ./typecheck-cache.integration.test.ts` | all exit 0 |
| AC3 | No doc references `packages/ui`; the theme-shape doc names `ThemeFile` | `git grep -nE "packages/ui\|@ycoding-ai/ui" -- . ':!bun.lock'` is empty; `bun test --cwd packages/tui test/theme.test.ts` (T3) | empty grep; green |
| AC4 | No schema V1 modules or subpaths, and no consumer breaks | `bun test --cwd packages/schema`; `bun test --cwd packages/codemode test/openapi.test.ts`; `bun run typecheck` | green; a V1 identifier grep over `packages apps` (excluding codemode fixtures) is empty |
| AC5 | Confirmed dead modules are removed | `bun run typecheck`; `bun run lint` (0 errors); `bun run lint:effect-patterns`; `bun test --cwd packages/core test/shared-schema.test.ts`; `bun test --cwd packages/ai test/cache-policy.test.ts` | green; the per-file greps in `checklist.md` S4 are empty |
| AC6 | The four legacy tables are dropped by a generated migration; other data survives | `bun run --cwd packages/core migration --check`; `bun test --cwd packages/core test/drop-legacy-account-share-migration.test.ts` (T5); `bun test --cwd packages/core test/database-migration.test.ts test/database-housekeeping.test.ts` | check exits 0; T5 RED, then green |
| AC7 | Every knip finding is triaged | knip run (D3); typecheck; lint; the affected package suites | zero untriaged rows; green |
| AC8 | Restructured files keep their public paths, namespaces, and behavior | restructure suites below, with **no assertion edits**; `bun run typecheck` | pass counts equal the post-SL baseline |
| AC9 | Every tracked source file is classified against `39fdd671` | `bun plans/codebase-cleanup/classify.ts` | class totals equal the tracked file count |
| AC10 | The whole change is clean | `bun run check:ycoding-workspace`; `bun run check:ycoding-brand`; `bun test --cwd script ./typecheck-cache.integration.test.ts`; `bun run typecheck`; `bun run lint`; `bun run lint:effect-patterns`; `bun run test:web`; `bun run test:remote`; `bun run build:web`; `bun run test:integration:web`; `bun run test:integration:remote`; `bun run test:cloudflare`; `bun run build:cloudflare`; targeted TUI tests (D15) plus the release-leg TUI suites; `cd packages/cli && bun test --timeout 30000`; `bun run test:extension`; `bun run build:tui`; `bun run smoke:tui`; `bun run smoke:runtime`; diff reviewed | all green, or failures matched to the S0 baseline |
| AC11 | The TUI has one theme system, and colors are unchanged unless a DESIGN.md rule says otherwise | T8; `bun test --cwd packages/tui test/design-md.test.ts`; targeted TUI tests for every migrated file (D15); `python3 ~/.agents/skills/daedalus/scripts/design_md.py lint packages/tui/DESIGN.md --strict` | green; `packages/tui/src/theme/current.ts` is deleted, the V1 proxy at `context/theme.tsx` is gone, and `ThemeService` has no `theme: Theme` field (typecheck proves there are no remaining readers) |
| AC12 | No upstream `V2` naming remains outside the documented non-targets | `bun plans/codebase-cleanup/v2-codemod.ts --check` (zero remaining matches); `bun run typecheck`; regenerated clients/OpenAPI show no diff on a second run; `bun test --cwd packages/core test/shared-schema.test.ts` | green; codemod check empty |
| AC13 | Renamed wire strings work end to end, and old relay versions are rejected | `bun test --cwd infra/cloudflare test/router.test.ts` (v3 rejected, v4 accepted); `bun run test:integration:remote`; `bun run test:web`; `bun test --cwd packages/cli test/run/noninteractive.test.ts`; `bun test --cwd packages/codemode test/openapi.test.ts` | green |
| AC14 | Each kept optimization is significant and correct | harness before/after (≥30 samples, Mann-Whitney U p < 0.05, median improvement ≥10% or approved), pressure categories per risk, and the affected package suites | recorded in `tracking.md` § Performance |
| AC16 | Leaner code with identical behavior | for each SC sub-slice: package typecheck; `bun run lint` (0 errors; touched-file warnings ≤ baseline); `bun run lint:effect-patterns`; the package lean suite and consumer suites pass with **no assertion edits**; `bun run build:tui` and `bun run smoke:tui` / `smoke:runtime` after SC-core, SC-tui, and SC-cli; M1 startup and binary size not worse than baseline (Mann-Whitney U) | recorded in `tracking.md` § Code leaning |
| AC15 | Lean suites still catch every retained behavior | for each package: inventory and classification complete; each removed group has a passing mutation probe (a mutation of the guarded behavior fails a retained test); three isolated runs plus one run under parallel load have zero failures (tui: batches of leaned files only, D15); `AGENTS.md` lean-testing rule updated | recorded in `tracking.md` § Test leaning |

## New and changed tests

| ID | File | Slice | Asserts | Expected RED |
|---|---|---|---|---|
| T1 | `packages/tui/test/attention-sounds.test.ts` (new) | S2 | The five exported sound paths resolve to existing, non-empty `.mp3` files | none (a guard that stays green before and after the move) |
| T2 | `packages/cli/test-integration/node-build.test.ts` (extend) | S2 | The Node build output contains the five sounds under the new keys | RED once switched to the new keys and before the assets move |
| T3 | `packages/tui/test/theme.test.ts` (edit) | S2 | `DEFAULT_THEMES.ycoding` exists and `DEFAULT_THEMES["oc-2"]` is undefined, without `@ycoding-ai/ui` | none |
| T5 | `packages/core/test/drop-legacy-account-share-migration.test.ts` (new) | S5 | After `applyOnly`, the four tables are gone and `session` rows are unchanged | RED (the migration import is missing) |
| T6 | `packages/schema/test/{legacy-event,v1-isolation}.test.ts` (delete) | S3 | removed with their modules | n/a |
| T7 | `packages/core/test/shared-schema.test.ts` (edit) | S4/S8 | S4 removes the `v2-schema` row; S8 adds identity rows for schema members re-exported by core namespaces | S8 rows RED until the re-export exists |
| T8 | `packages/tui/test/theme-v1-parity.test.ts` (new) | S7 | For 33 built-in themes × 2 modes × 63 V1 keys, the migrated token resolves to the recorded V1 color unless listed as a DESIGN.md change | written green against V1 first, kept green through the migration |
| T9 | `packages/cli/test/run/noninteractive.test.ts`, `apps/web/src/remote/projection.test.ts`, `apps/web/src/remote/notifications.test.ts` (edit) | S8 | Consumers react to `permission.asked`/`permission.replied` and `question.*` | RED after the test rename, before the producer rename |
| T10 | `infra/cloudflare/test/router.test.ts` (edit) | S8 | `/ws/v3/*` is rejected and `/ws/v4/*` is accepted | RED until `RemoteProtocolVersion` is 4 |

Write T2, T5, and T7–T10 inside the `codebase-cleanup` worktree when their slice starts, never leaving RED on `main`.

## Restructure suites (S9, AC8)

| File | Suites compared with the post-SL baseline |
|---|---|
| `packages/core/src/project-artifact.ts` | `bun test --cwd packages/core test/project-artifact*.test.ts`; `bun test --cwd packages/server test/project-artifact-handler.test.ts` |
| `packages/core/src/session.ts` | `bun test --cwd packages/core test/session*.test.ts` |

## Out of the test scope

The vendored Cursor provider and vendored OpenTUI are untouched. Live provider traffic is never used; performance runs use the local fake provider from `runtime-smoke`.
