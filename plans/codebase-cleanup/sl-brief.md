# SL test-suite leaning: shared worker brief

The user has decided (D11) that YCoding's tests are bloated. Rewrite and prune them so that only tests that need to exist remain, without losing protection of any required behavior.

## Keep

Keep a test only if it guards at least one of:
- a public contract: Schema, Protocol, durable events, generated client, remote envelopes, CLI flags or output;
- a documented runtime rule: Session admission and promotion, steps, autonomy, goal, guardrails, permissions, provider cache and usage, compaction, migrations, skills, subagents;
- a trust boundary: authentication, ownership, permissions, path containment, secret redaction;
- a reproduced regression (a test named or written for a real past bug);
- a cross-component flow, or rendered TUI or web behavior;
- a design-drift gate (`design-md` tests).

Test each behavior once, at the lowest layer that can detect it, plus one flow test where layers interact.

## Remove or rewrite

- **Delete:**
  - tests asserting on production source text (`Bun.file(new URL("../src/…")).text()` plus `toContain`);
  - tests that only confirm a mock was called;
  - tests of private helpers already covered through their public caller;
  - near-duplicate permutations of one rule (merge them into one table-driven `test.each`);
  - snapshot or current-output assertions with no stated requirement;
  - tests of removed or dead features;
  - coverage-only cases;
  - duplicated setup boilerplate (extract it only when it is reused).
- **Rewrite:** tests that depend on `Bun.sleep`, `setTimeout`, or wall-clock timing to pass. Use deterministic awaits on the actual event or state, `TestClock`, or `Deferred`. They must pass under CPU load.
- **Never weaken** an assertion just to make a test pass. A test that is wrong because behavior intentionally changed gets fixed to assert the intended behavior. If you find a test that fails because production is wrong, do not delete it: write it up in the report as a defect, with evidence.

## Always keep

Do not remove these; you may still deduplicate within them:
- release-workflow suites:
  - TUI: `test/session-transcript-live-fixes.test.tsx`, `test/cli/tui/permission-interaction.test.tsx`, `test/cli/tui/permission.test.ts`, `test/util/permission.test.ts`, `test/branding.test.ts`;
  - core: `test/session-execution.test.ts`, `test/session-autonomy.test.ts`;
  - every `packages/cli` test, `apps/web` remote tests, and `script/*.test.ts` release contracts;
- `design-md` tests;
- Schema, Protocol, and Client contract suites;
- migration tests;
- remote ownership and relay-security tests;
- provider cache and usage normalization tests;
- `packages/ai` recorded-fixture golden tests (`*.recorded.test.ts`).

## Method

1. **Inventory first.** Write `plans/codebase-cleanup/test-inventory/<your-area>.md`. For each test file record the cases (count), behaviors guarded, layer, wall time (`bun test <file>` time, run alone), and a classification per case or case-group: `keep`, `merge`, `rewrite`, or `delete`, each with a one-line reason.
2. **Map** each retained behavior to its surviving assertion before deleting anything.
3. **Apply** the changes in coherent commits per file group: `test(<pkg>): …`.
4. **Mutation probes.** For each deleted or merged group whose behavior is still required, temporarily mutate the guarded production line (invert a condition, drop a call). Observe that a retained test fails, then revert the mutation with `git checkout -- <file>`. Record each probe (file:line, mutation, failing test) in the inventory. Production code must be unchanged at the end, except where you fix a reported defect with a RED test first.
5. **Stability:** each touched test file passes three times in a row when run alone, and once while another heavy command runs in parallel (for example a typecheck).
6. **Report** before and after numbers for your area: test files, cases, lines (`wc -l`), and total isolated wall time.

## Rules

- **Worktree:** work only in your assigned worktree and branch, and never push.
- **Identity:** commit with the existing git identity. Never set user.name or user.email, never pass `--author`, and never add AI attribution.
- **Style:** follow the worktree `AGENTS.md` style (no aliased or star imports, no code comments, Bun APIs, Effect patterns).
- **TUI:** never run the full TUI suite. Run TUI test files one file per process; many TUI files in one Bun process interfere (G13).
- **Memory limits:** `memory_limit_mb` 8192 per test command, 12288 for root typecheck.
- **Final checks** for your area: package typecheck, root `bun run typecheck`, `bun run lint` (0 errors), `bun run lint:effect-patterns`, and every retained test file in your area passing (run per file for TUI).
- **Stop and report** if a required behavior has no surviving guard and you cannot write one, or if production code appears wrong.
