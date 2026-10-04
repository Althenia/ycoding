# Codebase cleanup — checklist

Tick an item only when its evidence is recorded in `tracking.md`. Slice order, gates, and designs are in `plan.md`. Checks are in `testing.md`.

## Pre-flight (every slice)

- [x] v0.8.9 is released, and the worktree `.worktrees/codebase-cleanup` (branch `codebase-cleanup`) is rebased on the current `main`.
- [ ] Search every symbol, file, subpath, or string to be removed or renamed across `packages apps infra script extensions docs specs .okf`. Cover imports, strings, config, routes, schema, fixtures, package `exports`/`imports` maps, and globs.
- [ ] No in-flight branch touches the slice's files (`git diff --name-only main...<branch>`).
- [ ] Log every defect or gap found as a `tracking.md` § Defects row. Fix it with a reproduction test first.

## S0 — Baseline

- [x] `git worktree add -b codebase-cleanup .worktrees/codebase-cleanup main`, then `bun install --frozen-lockfile` (cloud session: branch `v0.9.0-wip`, D41).
- [x] Recheck every historical baseline row in `plan.md` against the new `main`; leave unrecounted historical totals explicitly unresolved.
- [x] Run every AC10 command one at a time. Record results and pre-existing failures in § Baseline.
- [ ] Build the P0 harness and record the baseline (see § P).

## S1 — Fork-point classification

- [x] Recreate the blobless clone of `anomalyco/opencode` outside the repository (E1–E2).
- [x] `plans/codebase-cleanup/classify.ts` gives each tracked file under `packages/` exactly one class against `39fdd671`: `upstream-unchanged`, `upstream-modified`, `ycoding-new`, or `vendored`. Files are matched by blob, or by blob after reversing the rebrand (E12).
- [x] Write `classification.md` with totals per package and a list of in-use `upstream-unchanged` files (E12, E38–E73, E78).
- [x] Feed the in-use `upstream-unchanged` list into the SC ranking (`code-leaning/*.md` S1 anchors and E78 hand-off notes).

## S2 — Remove `packages/ui`

- [x] Add T1 and confirm it is green on the baseline.
- [x] `git mv` the five `.mp3` files to `packages/tui/src/assets/audio/`.
- [x] `tui/src/attention-sounds.bun.ts`: relative `./assets/audio/*.mp3` imports `with { type: "file" }`.
- [x] `tui/src/attention-sounds.node.ts`:
  - Packaged mode: key `@ycoding-ai/tui/audio/<name>` under `YCODING_NODE_ASSETS_DIR`.
  - Source mode: `fileURLToPath(new URL(\`./assets/audio/${name}\`, import.meta.url))`.
- [x] `tui/src/audio.d.ts`: drop the `@ycoding-ai/ui/audio/*.mp3` declaration.
- [x] `cli/src/node/target.ts`: keys become `@ycoding-ai/tui/audio/<name>.mp3`.
- [x] `cli/script/node-assets.ts`: source becomes `../tui/src/assets/audio`.
- [x] T2: RED, then GREEN.
- [x] T3.
- [x] Remove `@ycoding-ai/ui` from:
  - the root `package.json` workspaces;
  - `tui/package.json`;
  - `script/ycoding-workspace.ts`;
  - `cli/test/import-boundaries.test.ts`;
  - the `turbo.json` `@ycoding-ai/ui#test` entry;
  - the `script/raw-changelog.ts` `packages/ui/` mapping.
- [x] `git rm -r packages/ui`, then `bun install`. The lock diff shows only the UI-exclusive removals:
  - `@shikijs/transformers`;
  - `@solid-primitives/{bounds,event-listener,media,resize-observer}`;
  - `@types/katex`, `katex`, `marked-katex-extension`;
  - `dompurify`, `morphdom`;
  - `motion`, `motion-dom`, `motion-utils`;
  - `tw-animate-css`, `vite-plugin-icons-spritesheet`.
- [x] Docs:
  - `docs/architecture.md`: list, diagram, and supporting-packages bullet.
  - `docs/repository-resources.md:103,464`: point the theme shape at `packages/tui/src/theme/v2/schema.ts` `ThemeFile` (D5) (G1).
- [x] Run AC1–AC3.

## S3 — Remove schema V1

- [x] `git rm -r packages/schema/src/v1`.
- [x] `git rm` the `schema/src/{filesystem-v1,permission-v1,question-v1,session-v1,legacy-event}.ts` modules and the T6 tests.
- [x] Keep the codemode OpenAPI fixture content; it is renamed in S8.
- [x] `packages/ai/STATUS.md:105`: remove the nonexistent `core/src/v1/...` path (G2).
- [x] Run AC4.

## S4 — Remove dead modules

Each item needs an empty reference grep first.

- [x] `core/src/util/{iife,array,module,retry,binary}.ts`.
- [x] `core/src/v2-schema.ts`, plus T7 (remove its row).
- [x] `tui/src/component/brand-art.ts`, `tui/src/component/prompt/cwd.ts`, `tui/src/feature-plugins/sidebar/lsp.tsx` (G3).
- [x] `ai/src/providers/openrouter-responses.ts`. Keep the `"openrouter-responses"` route IDs.
- [x] Run AC5.

## S5 — Drop legacy tables

- [x] T5: RED.
- [x] `git rm core/src/account.ts core/src/account/sql.ts core/src/share/sql.ts`.
- [x] `bun run --cwd packages/core migration --name drop-legacy-account-share`. The generator owns the migration, `schema.json`, `schema.gen.ts`, and `migration.gen.ts`.
- [x] Confirm the generated SQL drops `account_state` before `account`, drops `session_share`, and leaves `session` untouched.
- [x] Run AC6.

## S6 — Unused exports

- [x] Run `bunx knip` once (D3, E15).
- [x] Triage every finding in § Unused exports as `remove`, `keep:public`, `keep:dynamic`, or `keep:test-only`. Include G4 (`SessionRestart.resumeSuspendedSessions`, which only tests call). The canonical 719-row disposition also records `keep:vendored` (E28).
- [x] Remove in package-sized batches, running that package's typecheck and suite after each batch (E16–E17, E27–E28).
- [x] Run AC7.

## SL — Test-suite leaning

Per package, in this order:
1. core
2. tui
3. ai
4. codemode
5. cli
6. server
7. schema, protocol, client
8. simulation, remote, remaining packages
9. `apps/web`
10. `infra/cloudflare`

- [ ] Inventory every case (file, behavior, layer, wall time) in § Test leaning, using `bun test --reporter=junit --reporter-outfile` for wall time.
- [ ] Classify each case as `keep`, `merge`, `rewrite`, or `delete`, with a reason, using the keep/remove rules in `plan.md`.
- [ ] Map every retained behavior to its surviving assertion before deleting anything.
- [ ] Delete the 14 source-text-assertion files' source-text cases, or replace them with render or behavior assertions where the behavior is required.
- [ ] Rewrite flaky timing tests (G10) to deterministic waits or `TestClock`.
- [ ] Mutation-probe each removed group: mutate the guarded production line, observe a failing retained test, then revert.
- [ ] Three isolated runs plus one under parallel load, all with zero failures. For tui, run the leaned files in batches of changed files, never the whole suite (D15). Record before/after files, cases, lines, and wall time.
- [ ] Never remove the always-kept suites listed in `plan.md`.
- [x] Update `AGENTS.md` § Testing with the lean-testing rule (`ecfaff06`; verified on local target).
- [ ] Run AC15.

## S7 — TUI theme V1 removal

- [ ] Read root `DESIGN.md` and `packages/tui/DESIGN.md`. Add token rules for the five open migration items, then lint both with `design_md.py lint --strict`.
- [ ] Write T8 green against V1.
- [ ] Migrate the 253 V1 reads in 23 files.
- [ ] Delete the V1 proxy, `theme/current.ts`, and the V1 `theme: Theme` field.
- [ ] Delete `specs/v2/tui-theme-migration.md`.
- [ ] Run AC11.

## SC — Code leaning

Sub-slices run one package at a time, in this order:
1. core
2. tui
3. cli
4. web
5. ai
6. codemode
7. server
8. schema/protocol/client/plugin
9. cloudflare

- [ ] Record the package baseline: source lines, files, the lean-suite pass count, and (core/tui/cli) M1 startup and binary size.
- [ ] Map the public surface (package `exports`, plugin API, Protocol), the module graph, and size × churn × S1 class. Write the ranked module list in `tracking.md` § Code leaning.
- [x] Duplication scan (D14): `bunx jscpd` once per package, with no repository change. Record the clone groups in the package ranking (E80).
- [ ] Apply the lean targets from `plan.md` in priority order, in reviewable batches.
- [ ] After each batch: package typecheck; `bun run lint` (0 errors, no new warnings in touched files); `bun run lint:effect-patterns`; the package lean suite and consumer suites with no assertion edits.
- [ ] For each removed compatibility path, confirm with `rg` that no live caller, config, fixture, or stored-data reader needs it. If stored data needs it, stop and ask.
- [ ] A defect found while leaning gets a Defects row, a RED test, then the fix.
- [ ] Record the package's before/after numbers. Run AC16.
- [ ] Commit per package sub-slice.

## S8 — V2 naming removal and remote protocol 4

- [ ] Prerequisite: `shell-durable`, `multi-remote`, and `web-model-sort` are merged, or their owners will rebase with the codemod.
- [ ] Write `plans/codebase-cleanup/v2-codemod.ts`: an explicit identifier/string map with word boundaries, the non-target list from `plan.md`, and a `--check` mode.
- [ ] Core namespaces lose the suffix. Resolve the ~47 collision files by using the core namespace plus core re-exports of schema members. Add T7 identity rows. No import aliases.
- [ ] Rename these string identifiers together with every `catchTag` user:
  - Schema class/brand IDs;
  - tagged-error tags;
  - `Effect.fn` span names;
  - `@ycoding/v2/*` service keys.
- [ ] Protocol:
  - 172 operation IDs drop the `v2.` prefix;
  - `V2Event` → `ServerEvent`;
  - remove the codegen `v2` branch (G6);
  - regenerate clients/OpenAPI with the owning command.
- [ ] Ephemeral events become `permission.{asked,replied}` and `question.{asked,replied,rejected}`, applied to every consumer (T9).
- [ ] `RemoteProtocolVersion` 3 → 4:
  - `infra/cloudflare/src/index.ts` docs;
  - T10;
  - `docs/remote-deployment.md`;
  - `packages/remote/CONTRACT.md`;
  - the real-flow script.
- [ ] TUI:
  - `themeV2`/`valuesV2`/`contextsV2`/`setThemeV2` → `theme`/`values`/`contexts`/`setTheme`;
  - merge `theme/v2/*` into `theme/`;
  - `mini/stream-v2.*` → `mini/stream.*`;
  - remove the `ThemeSource` alias (G7).
- [ ] `specs/v2/*` → `specs/`. Update every reference, including `AGENTS.md` files and docs.
- [ ] Rename the codemode fixture `ycoding-v2-openapi.json` to `ycoding-openapi.json`.
- [ ] Regenerate `.okf` and `docs/okf` through their owner.
- [ ] Run AC12 and AC13.

## S9 — Restructure

- [ ] `project-artifact.ts`: move internals under `project-artifact/` and keep `@ycoding-ai/core/project-artifact` and its namespace.
- [ ] `session.ts`: same pattern, after `shell-durable` has merged.
- [ ] No behavior change and no assertion edits. Run AC8.

## P — Performance

- [ ] P0 harness in `plans/codebase-cleanup/perf/`: M1–M8 from `plan.md`, at least 30 samples, warmup, median/p95/RSS, and Mann-Whitney U.
- [ ] Profiling tools: Bun 1.4.2 lists `--cpu-prof`, `--cpu-prof-name`, and `--cpu-prof-dir` (checked 2026-10-02) but no `--heap-prof`. Measure memory with `process.memoryUsage()` sampling and RSS from `ps`. `hyperfine` is installed at `/opt/homebrew/bin/hyperfine`.
- [ ] Record the P0 baseline at S0, then rerun it after S9.
- [ ] For each Pn:
  1. Profile and record the hot path and dominant cost.
  2. Make one change.
  3. Rerun the same harness.
  4. Run the pressure categories that match its risk.
  5. Run the package suites.
  6. Keep the change only if it meets AC14; otherwise revert only that change and record the negative result.
- [ ] Never change model-visible prefixes or cache placement for speed.

## S11 — Close-out

- [ ] Run all of AC10 one at a time.
- [ ] `git diff --stat main...codebase-cleanup` contains no plan or tracking files and no unintended changes.
- [ ] Docs updated in the same change as the code (`plan.md` § Documentation updates).
- [ ] The next release note lists:
  - removed subpaths;
  - the table drop;
  - operation-ID and event renames;
  - the remote protocol bump;
  - measured performance changes.
- [ ] Commit per slice with conventional messages. Rebase on `main`, then `git merge --ff-only --autostash codebase-cleanup`.
- [ ] Update the stale memory note `cli/managed-restart-interrupts-sessions` (G5).
- [ ] Remove `/^plans\/codebase-cleanup\//` from `upstreamPaths` in `script/ycoding-rebrand.ts` and its test case when the plan directory is deleted (E79).
